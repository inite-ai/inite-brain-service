import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
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

const SUBJECT_SHAPE = /^(key|jwt):[A-Za-z0-9:_-]{1,128}$/;

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
      const [rows] = await db.query<[any[]]>(
        `SELECT * FROM access_policy ORDER BY name`,
      );
      const [bindings] = await db.query<[any[]]>(
        `SELECT subject, policyNames FROM policy_binding`,
      );
      const attachedBy = new Map<string, string[]>();
      for (const b of (bindings as any[]) ?? []) {
        for (const name of (b.policyNames as string[]) ?? []) {
          const list = attachedBy.get(name) ?? [];
          list.push(String(b.subject));
          attachedBy.set(name, list);
        }
      }
      return ((rows as any[]) ?? []).map((r) => mapRow(r, attachedBy));
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
      const [updated] = await db.query<[any[]]>(
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
      if (((updated as any[]) ?? []).length === 0) {
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
      const [rows] = await db.query<[any[]]>(
        `SELECT * FROM policy_binding ORDER BY subject`,
      );
      return ((rows as any[]) ?? []).map((r) => ({
        subject: String(r.subject),
        policyNames: ((r.policyNames as string[]) ?? []).map(String),
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
        const [rows] = await db.query<[any[]]>(
          `SELECT policyNames FROM policy_binding WHERE subject = $subject`,
          { subject },
        );
        const existing: string[] =
          ((rows as any[])?.[0]?.policyNames as string[]) ?? [];
        if (existing.includes(name)) continue;
        if (existing.length >= MAX_SETS_PER_KEY) {
          throw new BadRequestException(
            `Subject '${subject}' already carries ${existing.length} policy sets (max ${MAX_SETS_PER_KEY})`,
          );
        }
        if (rows && (rows as any[]).length > 0) {
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
    const row = await this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT predicate, source, trustSnapshot, corroboration, userId
           FROM type::record('knowledge_fact', $id) LIMIT 1`,
        { id },
      );
      return ((rows as any[]) ?? [])[0];
    });
    if (!row) throw new NotFoundException(`Fact ${factIdRaw} not found`);
    return row;
  }
}

const FACT_ID_SHAPE = /^[A-Za-z0-9_]+$/;

function mapRow(r: any, attachedBy: Map<string, string[]>): StoredPolicySet {
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
