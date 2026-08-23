import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows, queryFirst } from '../db/surreal.service';
import { sanitizeSourceMeta } from './source-meta';
import { PolicyResolverService } from './policy-resolver.service';
import {
  MAX_SETS_PER_KEY,
  PolicyDocument,
  PolicyDocumentSchema,
  PolicyMode,
} from './policy.types';

export interface StoredPolicySet {
  name: string;
  mode: PolicyMode;
  document: PolicyDocument;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  attachedSubjects: string[];
}

export interface StoredBinding {
  subject: string;
  policyNames: string[];
  updatedAt: string;
}

/** Policy-relevant projection of a fact (explain + simulation). */
export interface FactPolicyView {
  id?: unknown;
  predicate: string;
  source?: unknown;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

const SUBJECT_SHAPE = /^(key|jwt|agent):[A-Za-z0-9:._-]{1,200}$/;

/** Row shape of the `access_policy` table (migration 0056). */
interface AccessPolicyRow {
  name: unknown;
  mode: unknown;
  document: PolicyDocument;
  version?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

/** Row shape of the `policy_binding` table. */
interface PolicyBindingRow {
  subject: unknown;
  policyNames?: string[];
  updatedAt?: unknown;
}

/** `source_document` projection used by the source-meta backfill. */
interface SourceDocMetaRow {
  id: unknown;
  meta?: unknown;
  createdAt?: unknown;
}

/**
 * CRUD over the per-tenant ABAC tables (migration 0056). Writes are
 * admin-only and run on the root pool; every mutation invalidates the
 * tenant's resolver snapshot in-process (other instances converge
 * within POLICY_CACHE_TTL_MS).
 *
 * The `mode` column mirrors document.mode so list queries never parse
 * documents; the document itself is the source of truth and the two
 * are written together.
 */
@Injectable()
export class PolicyStoreService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly resolver: PolicyResolverService,
  ) {}

  /** Validate an untrusted document body. Throws 400 with zod issues. */
  parseDocument(body: unknown): PolicyDocument {
    const parsed = PolicyDocumentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_policy_document',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return parsed.data;
  }

  async list(companyId: string): Promise<StoredPolicySet[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<AccessPolicyRow>(
        db,
        `SELECT * FROM access_policy ORDER BY name`,
      );
      const bindings = await queryRows<PolicyBindingRow>(
        db,
        `SELECT subject, policyNames FROM policy_binding`,
      );
      const attachedBy = new Map<string, string[]>();
      for (const b of bindings) {
        for (const name of b.policyNames ?? []) {
          const list = attachedBy.get(name) ?? [];
          list.push(String(b.subject));
          attachedBy.set(name, list);
        }
      }
      return rows.map((r) => mapRow(r, attachedBy));
    });
  }

  async get(companyId: string, name: string): Promise<StoredPolicySet> {
    const found = (await this.list(companyId)).find((s) => s.name === name);
    if (!found) {
      throw new NotFoundException(`Policy set '${name}' not found`);
    }
    return found;
  }

  async create(
    companyId: string,
    body: unknown,
    updatedBy: string,
  ): Promise<StoredPolicySet> {
    const doc = this.parseDocument(body);
    await this.surreal.withCompany(companyId, async (db) => {
      try {
        await db.query(
          `CREATE access_policy CONTENT {
             name: $name, mode: $mode, document: $document,
             version: 1, updatedBy: $updatedBy
           }`,
          { name: doc.name, mode: doc.mode, document: doc, updatedBy },
        );
      } catch (e) {
        if (/index|unique|exists/i.test((e as Error).message)) {
          throw new ConflictException(`Policy set '${doc.name}' already exists`);
        }
        throw e;
      }
    });
    this.resolver.invalidate(companyId);
    return this.get(companyId, doc.name);
  }

  /**
   * Whole-document replace with optimistic concurrency. The document's
   * name must match the path name — renames are deliberately not
   * supported (bindings and JWT claims reference sets by name).
   */
  async update(
    companyId: string,
    name: string,
    change: { body: unknown; expectedVersion: number; updatedBy: string },
  ): Promise<StoredPolicySet> {
    const { body, expectedVersion, updatedBy } = change;
    const doc = this.parseDocument(body);
    if (doc.name !== name) {
      throw new BadRequestException(
        `Policy set name is immutable ('${name}' → '${doc.name}' not allowed)`,
      );
    }
    const current = await this.get(companyId, name);
    if (current.version !== expectedVersion) {
      throw new ConflictException({
        error: 'version_conflict',
        current,
      });
    }
    await this.surreal.withCompany(companyId, async (db) => {
      const updated = await queryRows<AccessPolicyRow>(
        db,
        `UPDATE access_policy SET
           mode = $mode, document = $document, version = version + 1,
           updatedAt = time::now(), updatedBy = $updatedBy
         WHERE name = $name AND version = $version RETURN AFTER`,
        {
          name,
          mode: doc.mode,
          document: doc,
          version: expectedVersion,
          updatedBy,
        },
      );
      if (updated.length === 0) {
        // Raced with a concurrent writer between our read and write.
        throw new ConflictException({ error: 'version_conflict', current });
      }
    });
    this.resolver.invalidate(companyId);
    return this.get(companyId, name);
  }

  async remove(companyId: string, name: string): Promise<void> {
    const current = await this.get(companyId, name);
    if (current.attachedSubjects.length > 0) {
      throw new ConflictException({
        error: 'policy_attached',
        message: `Policy set '${name}' is attached to ${current.attachedSubjects.length} key(s) — detach first`,
        attachedSubjects: current.attachedSubjects,
      });
    }
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(`DELETE access_policy WHERE name = $name`, { name });
    });
    this.resolver.invalidate(companyId);
  }

  async listBindings(companyId: string): Promise<StoredBinding[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<PolicyBindingRow>(
        db,
        `SELECT * FROM policy_binding ORDER BY subject`,
      );
      return rows.map((r) => ({
        subject: String(r.subject),
        policyNames: (r.policyNames ?? []).map(String),
        updatedAt: String(r.updatedAt ?? ''),
      }));
    });
  }

  /**
   * Attach/detach one policy set for a batch of subjects. Subjects are
   * `key:<keyHash>` (static keys) or `jwt:<sub>` (JWT keys without a
   * jti). Attaching validates the set exists — this is what makes the
   * resolver's fail-closed branch unreachable through our own CRUD.
   */
  async updateAttachments(
    companyId: string,
    name: string,
    changes: { attach: string[]; detach: string[] },
  ): Promise<StoredPolicySet> {
    const { attach, detach } = changes;
    await this.get(companyId, name); // 404 when the set doesn't exist
    for (const s of [...attach, ...detach]) {
      if (!SUBJECT_SHAPE.test(s)) {
        throw new BadRequestException(`Invalid subject '${s}'`);
      }
    }
    await this.surreal.withCompany(companyId, async (db) => {
      for (const subject of attach) {
        const rows = await queryRows<PolicyBindingRow>(
          db,
          `SELECT policyNames FROM policy_binding WHERE subject = $subject`,
          { subject },
        );
        const existing: string[] = rows[0]?.policyNames ?? [];
        if (existing.includes(name)) continue;
        if (existing.length >= MAX_SETS_PER_KEY) {
          throw new BadRequestException(
            `Subject '${subject}' already carries ${existing.length} policy sets (max ${MAX_SETS_PER_KEY})`,
          );
        }
        if (rows.length > 0) {
          await db.query(
            `UPDATE policy_binding SET policyNames += $name,
               updatedAt = time::now() WHERE subject = $subject`,
            { subject, name },
          );
        } else {
          await db.query(
            `CREATE policy_binding CONTENT {
               subject: $subject, policyNames: [$name]
             }`,
            { subject, name },
          );
        }
      }
      for (const subject of detach) {
        await db.query(
          `UPDATE policy_binding SET policyNames -= $name,
             updatedAt = time::now() WHERE subject = $subject`,
          { subject, name },
        );
        // Drop empty bindings so listBindings stays tidy.
        await db.query(
          `DELETE policy_binding WHERE subject = $subject AND array::len(policyNames) = 0`,
          { subject },
        );
      }
    });
    this.resolver.invalidate(companyId);
    return this.get(companyId, name);
  }

  /**
   * Batched policy-view load for the simulation surface: one query for
   * up to ~250 factIds (search candidateK cap), keyed by full record id.
   */
  async loadFactViews(
    companyId: string,
    factIds: string[],
  ): Promise<Map<string, FactPolicyView>> {
    const out = new Map<string, FactPolicyView>();
    if (factIds.length === 0) return out;
    const ids = factIds
      .map((raw) =>
        raw.startsWith('knowledge_fact:')
          ? raw.slice('knowledge_fact:'.length)
          : raw,
      )
      .filter((id) => FACT_ID_SHAPE.test(id));
    if (ids.length === 0) return out;
    const rows = await this.surreal.withCompany(companyId, async (db) =>
      queryRows<FactPolicyView>(
        db,
        `SELECT id, predicate, source, trustSnapshot, corroboration, userId
           FROM knowledge_fact
          WHERE id INSIDE $ids`,
        { ids: ids.map((id) => new StringRecordId(`knowledge_fact:${id}`)) },
      ),
    );
    for (const row of rows) {
      out.set(String(row.id), row);
    }
    return out;
  }

  /**
   * Backfill `source.meta` onto facts derived from documents that were
   * ingested BEFORE the projection landed (PR abac-surfaces). Batched:
   * up to `maxDocs` documents with meta per call; facts already
   * carrying meta are left untouched, so the endpoint is idempotent
   * and safe to repeat until `remaining` hits zero.
   */
  async backfillSourceMeta(
    companyId: string,
    maxDocs = 200,
  ): Promise<{ documentsProcessed: number; factsUpdated: number; remaining: number }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const docsOut = await queryRows<SourceDocMetaRow>(
        db,
        `SELECT id, meta, createdAt FROM source_document
          WHERE meta != NONE
          ORDER BY createdAt ASC`,
      );
      const docs = docsOut.filter(
        (d) =>
          d.meta &&
          typeof d.meta === 'object' &&
          Object.keys(d.meta).length > 0,
      );
      let factsUpdated = 0;
      let documentsProcessed = 0;
      for (const doc of docs.slice(0, maxDocs)) {
        const { meta } = sanitizeSourceMeta(doc.meta);
        documentsProcessed += 1;
        if (!meta) continue;
        const updated = await queryRows<unknown>(
          db,
          `UPDATE knowledge_fact SET source.meta = $meta
            WHERE source.documentId = $docId
              AND source.meta IS NONE
            RETURN VALUE id`,
          { meta, docId: String(doc.id) },
        );
        factsUpdated += updated.length;
      }
      return {
        documentsProcessed,
        factsUpdated,
        remaining: Math.max(0, docs.length - documentsProcessed),
      };
    });
  }

  /**
   * Recent active facts' policy views for the preview-rule sampler.
   * Bounded and approximate by design (ORDER BY recordedAt DESC).
   */
  async sampleFactViews(
    companyId: string,
    limit: number,
  ): Promise<FactPolicyView[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      // recordedAt must be IN the projection — SurrealQL 3.x refuses to
      // ORDER BY a field the SELECT didn't materialize (the "order
      // idiom" gotcha, see docs/document-pipeline.md).
      return queryRows<FactPolicyView>(
        db,
        `SELECT id, predicate, source, trustSnapshot, corroboration,
                userId, recordedAt
           FROM knowledge_fact
          WHERE retractedAt IS NONE
            AND status != 'compacted'
            AND status != 'corroborating'
          ORDER BY recordedAt DESC
          LIMIT $limit`,
        { limit },
      );
    });
  }

  /**
   * Load the policy-relevant view of one fact for the explain endpoint
   * (controllers must not touch src/db directly — layer purity).
   */
  async loadFactForExplain(
    companyId: string,
    factIdRaw: string,
  ): Promise<{
    predicate: string;
    source?: unknown;
    trustSnapshot?: { authority?: number } | null;
    corroboration?: { count?: number } | null;
    userId?: string | null;
  }> {
    const id = factIdRaw.startsWith('knowledge_fact:')
      ? factIdRaw.slice('knowledge_fact:'.length)
      : factIdRaw;
    if (!FACT_ID_SHAPE.test(id)) {
      throw new BadRequestException(`Malformed factId '${factIdRaw}'`);
    }
    const row = await this.surreal.withCompany(companyId, async (db) =>
      queryFirst<{
        predicate: string;
        source?: unknown;
        trustSnapshot?: { authority?: number } | null;
        corroboration?: { count?: number } | null;
        userId?: string | null;
      }>(
        db,
        `SELECT predicate, source, trustSnapshot, corroboration, userId
           FROM type::record('knowledge_fact', $id) LIMIT 1`,
        { id },
      ),
    );
    if (!row) throw new NotFoundException(`Fact ${factIdRaw} not found`);
    return row;
  }
}

const FACT_ID_SHAPE = /^[A-Za-z0-9_]+$/;

function mapRow(
  r: AccessPolicyRow,
  attachedBy: Map<string, string[]>,
): StoredPolicySet {
  return {
    name: String(r.name),
    mode: String(r.mode) as PolicyMode,
    document: r.document as PolicyDocument,
    version: Number(r.version ?? 1),
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? ''),
    updatedBy: String(r.updatedBy ?? ''),
    attachedSubjects: attachedBy.get(String(r.name)) ?? [],
  };
}
