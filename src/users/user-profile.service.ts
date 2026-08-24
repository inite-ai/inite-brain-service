import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { ReadPinService, derivedVersionFence } from '../episodes/read-pin.service';
import { makeRowPolicyFilter, type PolicyFilterableRow } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { envFlagEnabled } from '../common/env-validation';
import {
  PER_ASPECT_CAP,
  type ProfileFactWire,
  type ProfileSectionWire,
  type UserProfileWire,
} from './dto/user-profile.dto';

/**
 * Rolling user profile v1 (USER_PROFILE_API_ENABLED): a deterministic
 * query-time assembly of what the platform knows about one end-user,
 * shaped for direct prompt injection. No LLM calls anywhere — the
 * profile is a grouped, capped, stably-ordered projection of the
 * active fact rows visible in that user's scope.
 *
 * Same read contracts as the fact lanes:
 *  - user scope fail-closed idiom of the search where-builder (0055):
 *    tenant-global rows + that user's personal rows, never anyone
 *    else's. Derived typed atoms are tenant-global (the deriver does
 *    not stamp userId), so the global half is what carries them.
 *  - derived-world fence: ingested facts (derivedVersion IS NONE) AND
 *    the tenant's pinned derived world(s) read together —
 *    `(derivedVersion IS NONE OR <fence>)`.
 *  - lifecycle: the where-builder's "actual now" closure (retracted /
 *    compacted / corroborating out; superseded admitted only across a
 *    future-dated supersede gap; validity interval must contain now).
 *    'competing' is additionally excluded — a profile asserts current
 *    truth, not both sides of an unadjudicated duel.
 *  - predicate scope-fence + ABAC row verdict via makeRowPolicyFilter
 *    (registry-backed lookup), which is also the PII gate: predicates
 *    fenced with requiresScope 'brain:read_pii' surface only to
 *    callers holding that scope.
 */

/** Overfetch headroom over the caps: the row fence and the per-aspect
 *  cap both drop rows after the query, so the fetch is sized well past
 *  the hard response cap (200). */
const FETCH_CAP = 1000;

/** The one projection every policy-filtered fact read uses, plus the
 *  profile's own columns (the row filter reads source / trustSnapshot /
 *  corroboration / userId — audit 2026-08-19 P1). */
const PROFILE_PROJECTION =
  'id, predicate, object, confidence, validFrom, validUntil, ' +
  'source, trustSnapshot, corroboration, userId';

interface ProfileRow extends PolicyFilterableRow {
  object: string;
  confidence?: number;
  validFrom: Date | string;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toWireFact(r: ProfileRow): ProfileFactWire {
  const source = r.source as { kind?: unknown } | null | undefined;
  const kind = typeof source?.kind === 'string' ? source.kind : undefined;
  const lastAt = (r.corroboration as { lastAt?: Date | string } | null)?.lastAt;
  return {
    factId: String(r.id),
    statement: r.object,
    validFrom: toIso(r.validFrom),
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    ...(lastAt !== undefined ? { lastSeenAt: toIso(lastAt) } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
}

/** Deterministic within-section order: validFrom DESC, factId ASC. */
function compareFacts(a: ProfileFactWire, b: ProfileFactWire): number {
  if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? 1 : -1;
  return a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
}

interface SectionDraft {
  aspect: string;
  /** Any persona_attr typed atom promotes the whole section. */
  persona: boolean;
  /** Group size BEFORE the per-aspect cap — the ordering signal. */
  poolSize: number;
  facts: ProfileFactWire[];
}

/** persona_attr-first, then fact count DESC, then aspect ASC — every
 *  key is a stable sort key, so equal inputs render equal profiles. */
function compareSections(a: SectionDraft, b: SectionDraft): number {
  if (a.persona !== b.persona) return a.persona ? -1 : 1;
  if (a.poolSize !== b.poolSize) return b.poolSize - a.poolSize;
  return a.aspect < b.aspect ? -1 : a.aspect > b.aspect ? 1 : 0;
}

/** Group by predicate/aspect, cap per aspect, order sections, then cut
 *  to the global budget walking sections in their final order. */
function assembleSections(rows: ProfileRow[], maxFacts: number): ProfileSectionWire[] {
  const groups = new Map<string, ProfileFactWire[]>();
  for (const r of rows) {
    const list = groups.get(r.predicate);
    if (list) list.push(toWireFact(r));
    else groups.set(r.predicate, [toWireFact(r)]);
  }
  const drafts: SectionDraft[] = [...groups.entries()].map(([aspect, facts]) => {
    facts.sort(compareFacts);
    return {
      aspect,
      persona: facts.some((f) => f.kind === 'persona_attr'),
      poolSize: facts.length,
      facts: facts.slice(0, PER_ASPECT_CAP),
    };
  });
  drafts.sort(compareSections);

  const sections: ProfileSectionWire[] = [];
  let taken = 0;
  for (const d of drafts) {
    if (taken >= maxFacts) break;
    const facts = d.facts.slice(0, maxFacts - taken);
    taken += facts.length;
    sections.push({ aspect: d.aspect, facts });
  }
  return sections;
}

/** `- [aspect] statement (as of YYYY-MM-DD)` — one line per fact, in
 *  the exact section/fact order of the structured response. */
function renderProfileText(sections: ProfileSectionWire[]): string {
  const lines: string[] = [];
  for (const s of sections) {
    for (const f of s.facts) {
      lines.push(`- [${s.aspect}] ${f.statement} (as of ${f.validFrom.slice(0, 10)})`);
    }
  }
  return lines.join('\n');
}

@Injectable()
export class UserProfileService {
  private readonly logger = new Logger(UserProfileService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly readPin?: ReadPinService,
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  async getProfile(opts: {
    companyId: string;
    /** Already pinned by the controller (pinUserScope). */
    userId: string;
    callerScopes: readonly string[];
    maxFacts: number;
    lang?: string | undefined;
  }): Promise<UserProfileWire> {
    const { companyId, userId, callerScopes, maxFacts, lang } = opts;
    const derivedVersion =
      (await this.readPin?.resolveRead(companyId)) ?? ReadPinService.bootstrapRead();
    // The read-pin fence for the derived half, UNIONED with the legacy
    // namespace: the profile reads ingested user facts AND the pinned
    // derived world's typed atoms in one pass.
    const fence = derivedVersionFence(derivedVersion);
    const worldClause = `(derivedVersion IS NONE OR ${fence.clause.replace(/^AND\s+/, '')})`;

    const clauses = [
      // Audit 2026-08-21: STRICT user scope — a profile asserts facts
      // OF this user, and a tenant-global row is any knowledge about
      // any entity in the tenant, not established to be about them.
      // Derived facts grounded in this user's turns carry userId by
      // construction (derive-row-builder scope rule), so nothing of
      // the user's own derived memory is lost by the strict filter.
      // Global rows return only with an explicit subject/entity
      // binding — the documented v2.
      `userId = $scopeUserId`,
      worldClause,
      // Lifecycle "actual now" closure — copied from the search
      // where-builder (incl. the future-dated-supersede gap rule).
      `retractedAt IS NONE`,
      `status != 'competing'`,
      `validFrom <= time::now()`,
      `(validUntil IS NONE OR validUntil > time::now())`,
      `status != 'compacted'`,
      `status != 'corroborating'`,
      `(status != 'superseded' OR validUntil > time::now())`,
    ];
    const params: Record<string, unknown> = {
      scopeUserId: userId,
      fetchCap: FETCH_CAP,
      ...fence.params,
    };
    // Multilingual Tier 1: MULTILINGUAL_SOFT_LANG_FILTER turns the hard
    // same-language exclusion into a RANKING preference. The caller-supplied
    // `lang` is an explicit, high-confidence intent, so no separate
    // confidence gate is applied here (unlike the detected-query search
    // path). Off (default) → the byte-identical hard filter.
    let langOrderPrefix = '';
    if (lang) {
      if (envFlagEnabled(process.env.MULTILINGUAL_SOFT_LANG_FILTER)) {
        // Drop the exclusion; prefer same-language facts in the fetch order
        // (a ranking signal within the FETCH_CAP, never an exclusion) so a
        // cross-lingual fact is demoted, not hidden.
        langOrderPrefix = '(lang = $langFilter) DESC, ';
        params.langFilter = lang;
      } else {
        // Locale filter, soft on unstamped rows (the where-builder idiom).
        clauses.push(`(lang = $langFilter OR lang IS NONE)`);
        params.langFilter = lang;
      }
    }

    // Predicate scope-fence (the PII gate) + ABAC row verdict — the
    // same seam every fact read surface applies.
    const rowPolicy = makeRowPolicyFilter({
      callerScopes,
      surface: 'user_profile',
      policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
    });

    const rows = await this.surreal.withScopedCompany(companyId, callerScopes, async (db) => {
      const [res] = await db.query<[ProfileRow[]]>(
        `SELECT ${PROFILE_PROJECTION}
             FROM knowledge_fact
            WHERE ${clauses.join('\n              AND ')}
            ORDER BY ${langOrderPrefix}validFrom DESC, id ASC
            LIMIT $fetchCap`,
        params,
      );
      return res ?? [];
    });
    const visible = rows.filter((r) => rowPolicy.filter(r));
    rowPolicy.finish();
    if (rows.length >= FETCH_CAP) {
      this.logger.warn(
        `user profile fetch hit the ${FETCH_CAP}-row cap ` +
          `(companyId=${companyId}) — oldest facts may be missing`,
      );
    }

    const sections = assembleSections(visible, maxFacts);
    return {
      userId,
      generatedAt: new Date().toISOString(),
      factCount: sections.reduce((n, s) => n + s.facts.length, 0),
      sections,
      profileText: renderProfileText(sections),
    };
  }
}
