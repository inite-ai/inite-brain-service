import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { assertionOf, type Assertion, type InferredBy } from '../common/assertion';
import { ConsentService } from './consent.service';
import { purgeAffectRows } from './affect-purge';

/**
 * The purpose a person consents to for emotion to be inferred from what
 * they say (#909). The affect reader asks for it before it writes; its
 * withdrawal erases every inference (registered below).
 */
export const AFFECT_INFERENCE_PURPOSE = 'affect_inference';

/** Rows a category export or erase reaches, per kind. */
const CATEGORY_CAP = 2000;

export interface AffectFactWire {
  factId: string;
  aspect: string;
  statement: string;
  assertion: Assertion;
  inferredBy?: InferredBy;
  validFrom: string;
  validUntil?: string;
  retracted: boolean;
}

export interface AffectBeliefWire {
  beliefId: string;
  subject: string;
  field: string;
  statement: string;
  assertion: 'inferred';
  validFrom: string;
  status: string;
}

export interface AffectExport {
  userId: string;
  facts: AffectFactWire[];
  beliefs: AffectBeliefWire[];
}

export type AffectEraseScope = 'all' | 'inferred';

export interface AffectEraseResult {
  userId: string;
  scope: AffectEraseScope;
  factsDeleted: number;
  beliefsDeleted: number;
  /** Rows composed from erased facts (arcs, summaries) that quoted them. */
  derivedDeleted: number;
}

interface FactRow {
  id: unknown;
  predicate: string;
  predicateAlias?: string | null;
  object?: unknown;
  validFrom: Date | string;
  validUntil?: Date | string | null;
  status?: string;
  retractedAt?: unknown;
  source?: Record<string, unknown>;
}

interface BeliefRow {
  id: unknown;
  subject?: unknown;
  field?: unknown;
  statement?: unknown;
  validFrom: Date | string;
  status?: unknown;
}

/**
 * A person's emotional data as one category (#909 step 3): what they said
 * about how they feel, guesses put to them, and what a model inferred —
 * every fact whose predicate is classed `affect` and every belief stamped
 * `affect`. GDPR rights apply to the category on its own: the person can
 * see it, erase it (all of it, or only the inferences), and contest a
 * single inference, without touching the rest of their memory.
 */
@Injectable()
export class AffectPlaneService implements OnModuleInit {
  private readonly logger = new Logger(AffectPlaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly registry: PredicateRegistryService,
    private readonly consents: ConsentService,
  ) {}

  onModuleInit(): void {
    // Withdrawing consent to inference erases every inference.
    this.consents.registerRevocationHandler(AFFECT_INFERENCE_PURPOSE, {
      onRevoke: async (companyId, userId) => {
        const r = await this.erase({ companyId, userId, scope: 'inferred' });
        return {
          factsDeleted: r.factsDeleted,
          beliefsDeleted: r.beliefsDeleted,
          derivedDeleted: r.derivedDeleted,
        };
      },
    });
  }

  async export(opts: { companyId: string; userId: string }): Promise<AffectExport> {
    const { facts, declared } = await this.loadFacts(opts.companyId, opts.userId);
    const beliefs = await this.loadBeliefs(opts.companyId, opts.userId);
    return {
      userId: opts.userId,
      facts: facts.map((f) => factWire(f, declared(f))),
      beliefs: beliefs.map(beliefWire),
    };
  }

  async erase(opts: {
    companyId: string;
    userId: string;
    scope: AffectEraseScope;
  }): Promise<AffectEraseResult> {
    const { facts, declared } = await this.loadFacts(opts.companyId, opts.userId);
    const beliefs = await this.loadBeliefs(opts.companyId, opts.userId);
    const factIds = facts
      .filter((f) => opts.scope === 'all' || assertionOf(f.source, declared(f)) === 'inferred')
      .map((f) => String(f.id));
    // A belief is inferred by construction: both scopes erase them.
    const beliefIds = beliefs.map((b) => String(b.id));
    const counts = await this.surreal.withCompany(opts.companyId, (db) =>
      purgeAffectRows(db, { factIds, beliefIds }),
    );
    this.logger.log(
      `affect erase ${opts.companyId}: scope=${opts.scope} facts=${counts.factsDeleted} beliefs=${counts.beliefsDeleted} derived=${counts.derivedDeleted}`,
    );
    return { userId: opts.userId, scope: opts.scope, ...counts };
  }

  /**
   * The person says an inference about them is wrong: it is erased, and a
   * hash of what it said is kept so the reader never writes it again. Only
   * an inference or a guess can be contested; a stated fact is corrected by
   * retracting or restating it.
   */
  async contest(opts: {
    companyId: string;
    userId: string;
    id: string;
  }): Promise<{ contested: string; erased: AffectEraseResult }> {
    const { facts, declared } = await this.loadFacts(opts.companyId, opts.userId);
    const beliefs = await this.loadBeliefs(opts.companyId, opts.userId);
    const fact = facts.find((f) => String(f.id) === opts.id);
    const belief = beliefs.find((b) => String(b.id) === opts.id);
    if (!fact && !belief)
      throw new NotFoundException(`${opts.id} is not in this person's emotional data`);
    let statement: string;
    if (fact) {
      const assertion = assertionOf(fact.source, declared(fact));
      if (assertion !== 'inferred' && assertion !== 'hypothesis') {
        throw new BadRequestException(
          `${opts.id} is ${assertion}, not an inference or a guess — retract or restate it instead`,
        );
      }
      statement = String(fact.object ?? '');
    } else {
      statement = String(belief!.statement ?? '');
    }
    const statementHash = affectStatementHash(statement);
    const counts = await this.surreal.withCompany(opts.companyId, async (db) => {
      await db.query(`CREATE affect_contest CONTENT { userId: $u, statementHash: $h }`, {
        u: opts.userId,
        h: statementHash,
      });
      return purgeAffectRows(db, {
        factIds: fact ? [opts.id] : [],
        beliefIds: belief ? [opts.id] : [],
      });
    });
    return {
      contested: opts.id,
      erased: { userId: opts.userId, scope: 'inferred', ...counts },
    };
  }

  /** The tenant's predicates classed `affect` (pack-declared; registry-resolved). */
  private async affectPredicates(companyId: string): Promise<string[]> {
    const snapshot = await this.registry.getSnapshot(companyId);
    const defs = snapshot.policyById ?? snapshot.byId;
    return [...defs.values()].filter((d) => d.piiClass === 'affect').map((d) => d.predicateId);
  }

  private async loadFacts(
    companyId: string,
    userId: string,
  ): Promise<{ facts: FactRow[]; declared: (f: FactRow) => string | undefined }> {
    const preds = await this.affectPredicates(companyId);
    const lookup = await this.registry.rowPolicyLookup(companyId);
    const declared = (f: FactRow) => lookup(f.predicateAlias ?? f.predicate).assertion;
    if (preds.length === 0) return { facts: [], declared };
    const facts = await this.surreal.withCompany(companyId, (db) =>
      queryRows<FactRow>(
        db,
        `SELECT id, predicate, predicateAlias, object, validFrom, validUntil, status,
                retractedAt, source
           FROM knowledge_fact
          WHERE userId = $u AND (predicateAlias ?? predicate) INSIDE $preds
          ORDER BY validFrom DESC
          LIMIT ${CATEGORY_CAP}`,
        { u: userId, preds },
      ),
    );
    return { facts, declared };
  }

  private async loadBeliefs(companyId: string, userId: string): Promise<BeliefRow[]> {
    return this.surreal.withCompany(companyId, (db) =>
      queryRows<BeliefRow>(
        db,
        `SELECT id, subject, field, statement, validFrom, status
           FROM semantic_belief
          WHERE userId = $u AND piiClass = 'affect'
          ORDER BY validFrom DESC
          LIMIT ${CATEGORY_CAP}`,
        { u: userId },
      ),
    );
  }
}

/** The contest key: what was inferred, normalised, hashed — never the text. */
export function affectStatementHash(statement: string): string {
  const normal = statement.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normal).digest('hex');
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function factWire(f: FactRow, declared: string | undefined): AffectFactWire {
  const source = f.source ?? {};
  const by = source.inferredBy as InferredBy | undefined;
  return {
    factId: String(f.id),
    aspect: f.predicateAlias ?? f.predicate,
    statement: String(f.object ?? ''),
    assertion: assertionOf(source, declared),
    ...(by && typeof by.recorder === 'string' ? { inferredBy: by } : {}),
    validFrom: iso(f.validFrom),
    ...(f.validUntil ? { validUntil: iso(f.validUntil) } : {}),
    retracted: Boolean(f.retractedAt) || f.status === 'retracted',
  };
}

function beliefWire(b: BeliefRow): AffectBeliefWire {
  return {
    beliefId: String(b.id),
    subject: String(b.subject ?? ''),
    field: String(b.field ?? ''),
    statement: String(b.statement ?? ''),
    assertion: 'inferred',
    validFrom: iso(b.validFrom),
    status: String(b.status ?? 'active'),
  };
}
