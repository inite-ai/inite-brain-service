import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
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

/** How the person seemed to feel at a time, read from their words (0188). */
export interface AffectObservationWire {
  observationId: string;
  observedAt: string;
  valence: number;
  label: string;
  target?: string;
  /** The person's exact words it was read from. */
  quote: string;
  episodeId: string;
  confidence: number;
  assertion: 'inferred';
  inferredBy: InferredBy;
}

/** A risk of suicide or self-harm read from the person's words (#916, 0190). */
export interface RiskSignalWire {
  signalId: string;
  observedAt: string;
  level: 'concern' | 'urgent';
  quote: string;
  episodeId: string;
  confidence: number;
}

export interface AffectExport {
  userId: string;
  facts: AffectFactWire[];
  beliefs: AffectBeliefWire[];
  observations: AffectObservationWire[];
  riskSignals: RiskSignalWire[];
}

export type AffectEraseScope = 'all' | 'inferred';

export interface AffectEraseResult {
  userId: string;
  scope: AffectEraseScope;
  factsDeleted: number;
  beliefsDeleted: number;
  /** Rows composed from erased facts (arcs, summaries) that quoted them. */
  derivedDeleted: number;
  /** Inferences read from the person's words (0188). */
  observationsDeleted: number;
  /** Risk signals (0190) — erased with scope `all` only: they rest on the operator's basis, not on consent to inference. */
  riskSignalsDeleted: number;
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

interface ObservationRow {
  id: unknown;
  observedAt: Date | string;
  valence: number;
  label: string;
  target?: string | null;
  quote: string;
  episodeId: unknown;
  confidence: number;
  readerVersion: string;
  model?: string | null;
  modality?: string;
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
          observationsDeleted: r.observationsDeleted,
          riskSignalsDeleted: r.riskSignalsDeleted,
        };
      },
    });
  }

  async export(opts: { companyId: string; userId: string }): Promise<AffectExport> {
    const { facts, declared } = await this.loadFacts(opts.companyId, opts.userId);
    const beliefs = await this.loadBeliefs(opts.companyId, opts.userId);
    const observations = await this.loadObservations(opts.companyId, opts.userId);
    const risks = await this.surreal.withCompany(opts.companyId, (db) =>
      queryRows<{
        id: unknown;
        observedAt: Date | string;
        level: 'concern' | 'urgent';
        quote: string;
        episodeId: unknown;
        confidence: number;
      }>(
        db,
        `SELECT id, observedAt, level, quote, episodeId, confidence FROM risk_signal
          WHERE userId = $u ORDER BY observedAt DESC LIMIT ${CATEGORY_CAP}`,
        { u: opts.userId },
      ),
    );
    return {
      userId: opts.userId,
      facts: facts.map((f) => factWire(f, declared(f))),
      beliefs: beliefs.map(beliefWire),
      observations: observations.map(observationWire),
      riskSignals: risks.map((r) => ({
        signalId: String(r.id),
        observedAt: iso(r.observedAt),
        level: r.level,
        quote: r.quote,
        episodeId: String(r.episodeId),
        confidence: r.confidence,
      })),
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
    // A belief and an observation are inferred by construction: both scopes erase them.
    const beliefIds = beliefs.map((b) => String(b.id));
    const counts = await this.surreal.withCompany(opts.companyId, async (db) => ({
      ...(await purgeAffectRows(db, { factIds, beliefIds })),
      observationsDeleted: await eraseObservations(db, opts.userId),
      riskSignalsDeleted: opts.scope === 'all' ? await eraseRiskSignals(db, opts.userId) : 0,
    }));
    this.logger.log(
      `affect erase ${opts.companyId}: scope=${opts.scope} facts=${counts.factsDeleted} beliefs=${counts.beliefsDeleted} derived=${counts.derivedDeleted} observations=${counts.observationsDeleted}`,
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
    const target = await this.contestTarget(opts);
    const counts = await this.surreal.withCompany(opts.companyId, async (db) => {
      await db.query(`CREATE affect_contest CONTENT { userId: $u, statementHash: $h }`, {
        u: opts.userId,
        h: affectStatementHash(target.statement),
      });
      const purged = await purgeAffectRows(db, {
        factIds: target.kind === 'fact' ? [opts.id] : [],
        beliefIds: target.kind === 'belief' ? [opts.id] : [],
      });
      let observationsDeleted = 0;
      if (target.kind === 'observation') {
        await db.query(`DELETE $id`, { id: new StringRecordId(opts.id) });
        observationsDeleted = 1;
      }
      return { ...purged, observationsDeleted, riskSignalsDeleted: 0 };
    });
    return {
      contested: opts.id,
      erased: { userId: opts.userId, scope: 'inferred', ...counts },
    };
  }

  /**
   * What a contest names: an inference or a guess in the person's
   * emotional data. The statement hashed is what the reader would write
   * again — an observation's quote, a fact's or belief's statement.
   */
  private async contestTarget(opts: {
    companyId: string;
    userId: string;
    id: string;
  }): Promise<{ kind: 'fact' | 'belief' | 'observation'; statement: string }> {
    const { facts, declared } = await this.loadFacts(opts.companyId, opts.userId);
    const fact = facts.find((f) => String(f.id) === opts.id);
    if (fact) {
      const assertion = assertionOf(fact.source, declared(fact));
      if (assertion !== 'inferred' && assertion !== 'hypothesis') {
        throw new BadRequestException(
          `${opts.id} is ${assertion}, not an inference or a guess — retract or restate it instead`,
        );
      }
      return { kind: 'fact', statement: String(fact.object ?? '') };
    }
    const belief = (await this.loadBeliefs(opts.companyId, opts.userId)).find(
      (b) => String(b.id) === opts.id,
    );
    if (belief) return { kind: 'belief', statement: String(belief.statement ?? '') };
    const observation = (await this.loadObservations(opts.companyId, opts.userId)).find(
      (o) => String(o.id) === opts.id,
    );
    if (observation) return { kind: 'observation', statement: observation.quote };
    throw new NotFoundException(`${opts.id} is not in this person's emotional data`);
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

  private async loadObservations(companyId: string, userId: string): Promise<ObservationRow[]> {
    return this.surreal.withCompany(companyId, (db) =>
      queryRows<ObservationRow>(
        db,
        `SELECT id, observedAt, valence, label, target, quote, episodeId, confidence,
                readerVersion, model, modality
           FROM affect_observation
          WHERE userId = $u
          ORDER BY observedAt DESC
          LIMIT ${CATEGORY_CAP}`,
        { u: userId },
      ),
    );
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

/** Every observation of the person, and the reading marks (they hold no words, only ids). */
async function eraseObservations(
  db: { query<T extends unknown[]>(sql: string, params?: Record<string, unknown>): Promise<T> },
  userId: string,
): Promise<number> {
  const [, rows] = await db.query<[unknown, unknown[]]>(
    `LET $obs = (SELECT VALUE id FROM affect_observation WHERE userId = $u);
     DELETE $obs RETURN BEFORE;`,
    { u: userId },
  );
  return (rows ?? []).length;
}

async function eraseRiskSignals(
  db: { query<T extends unknown[]>(sql: string, params?: Record<string, unknown>): Promise<T> },
  userId: string,
): Promise<number> {
  const [, rows] = await db.query<[unknown, unknown[]]>(
    `LET $risks = (SELECT VALUE id FROM risk_signal WHERE userId = $u);
     DELETE $risks RETURN BEFORE;`,
    { u: userId },
  );
  return (rows ?? []).length;
}

function observationWire(o: ObservationRow): AffectObservationWire {
  return {
    observationId: String(o.id),
    observedAt: iso(o.observedAt),
    valence: o.valence,
    label: o.label,
    ...(o.target ? { target: o.target } : {}),
    quote: o.quote,
    episodeId: String(o.episodeId),
    confidence: o.confidence,
    assertion: 'inferred',
    inferredBy: {
      recorder: o.readerVersion,
      ...(o.model ? { model: o.model } : {}),
      modality: o.modality ?? 'text',
    },
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
