import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import {
  dbCreate,
  queryFirst,
  queryRows,
  retryOnUniqueViolation,
  runTransaction,
} from '../db/surreal.service';
import { EntityResolverService } from './entity-resolver.service';
import { EntityRef, IngestFactDto } from './dto/ingest-fact.dto';
import { externalRefKey, idTailOf } from './ingest-utils';
import { isCodeSymbolShaped, pathNeedlesForSymbol, symbolAliasForPath } from './code-alias';
import { scopeForUser } from '../auth/scope-tags';
import { envFlagEnabled } from '../common/env-validation';
import { analyzeConfusables } from '../common/text-sanitizer';

/**
 * Leading English articles the extractor inconsistently keeps on coined
 * entity names. Only these three: any longer list drifts into semantic
 * guessing ("some", "that") the reuse fence must not do.
 */
const LEADING_ARTICLE_RE = /^(?:the|a|an)\s+/;

/**
 * Article-variant expansion for the INGEST_ARTICLE_NORMALIZATION lookup
 * (pure, exported for tests): all leading-article forms of a lowercased
 * name OTHER than the name itself (the exact form was already tried by
 * step 2). "the office lease" → ["office lease", "a office lease",
 * "an office lease"]; "office lease" → ["the office lease", …]. A name
 * that IS just an article ("the") expands to nothing. Grammatical
 * a-vs-an misuse is deliberately included — the goal is recall on
 * variants of the SAME words, and the IN-lookup can only hit names that
 * actually exist.
 */
export function articleNameVariants(nameLc: string): string[] {
  const stripped = nameLc.replace(LEADING_ARTICLE_RE, '').trim();
  if (stripped === '' || stripped === nameLc.trim()) {
    const base = stripped === '' ? null : stripped;
    if (base === null) return [];
    return ['the', 'a', 'an'].map((art) => `${art} ${base}`);
  }
  const out = [stripped];
  for (const art of ['the', 'a', 'an']) {
    const variant = `${art} ${stripped}`;
    if (variant !== nameLc.trim()) out.push(variant);
  }
  return out;
}

/**
 * Entity-resolution slice of the ingest pipeline: turn a caller-supplied
 * reference (externalRef / canonical name / bare entityId) into a concrete
 * knowledge_entity id, minting one when absent. Every method takes the live
 * `db` from the surrounding `withCompany` session, so this service carries no
 * SurrealService dep of its own — only the optional inline resolver.
 *
 * Shared by all three ingest paths: typed fact (resolveOrCreateEntity),
 * mention (resolveOrCreateNamedEntity), and link (resolveOrCreateBareRef).
 */
@Injectable()
export class EntityUpsertService {
  private readonly logger = new Logger(EntityUpsertService.name);

  constructor(
    // @Optional: when the resolver isn't wired (or its flag is off), the
    // mention path simply skips inline resolution and creates new as before.
    @Optional() private readonly entityResolver?: EntityResolverService,
  ) {}

  /**
   * Resolve an entity by externalRef, creating it if absent. Atomic against
   * concurrent ingests — relies on UNIQUE on entity_external_ref.key. The
   * pattern is: indexed read first (the common path), and on miss enter a
   * transaction that re-reads under tx scope and creates both rows or neither.
   * On a unique violation (another caller created the same ref between our
   * read and write) we retry; the next read finds the row.
   */
  async resolveOrCreateEntity(db: Surreal, dto: IngestFactDto, userId?: string): Promise<string> {
    if ('entityId' in dto.entityRef && dto.entityRef.entityId) {
      // A bare entityId attaches to that entity whatever its scope — the
      // trusted caller can put a personal fact on a shared entity.
      return dto.entityRef.entityId;
    }
    const ref = dto.entityRef as { vertical: string; id: string };
    // User scope (0055): the UNIQUE external-ref key is the dedup axis, so
    // a user-scoped ref must never collide with the tenant-global one (or
    // another user's) for the same (vertical, id). Fold the scope into the
    // key and stamp it on the minted entity.
    const baseKey = externalRefKey(ref.vertical, ref.id);
    // Scope separator MUST be a byte externalRefKey never emits, or a
    // dotted id folds into the marker and a tenant-global ref collides
    // with a user-scoped one (e.g. global "x.u.bob" → "x__u__bob" ==
    // scoped ("x", user "bob") under the old "__u__" marker — no crafted
    // input needed). externalRefKey only ever produces [word]/`__`, never
    // a colon, so "::u::" cannot be forged from the (vertical, id) side.
    const refKey = userId ? `${baseKey}::u::${userId}` : baseKey;
    return this.upsertEntityByExternalRef(db, refKey, () => ({
      type: 'other',
      canonicalName: ref.id,
      externalRefs: { [refKey]: ref.id },
      // G6 step 1: mirror the per-user scope as a scope tag (0093) next
      // to the userId stamp. The named-entity path stays tenant-global
      // (no userId → the scope field DEFAULT [] holds).
      ...(userId ? { userId, scope: scopeForUser(userId) } : {}),
    }));
  }

  async upsertEntityByExternalRef(
    db: Surreal,
    key: string,
    factory: () => Record<string, unknown>,
  ): Promise<string> {
    // SurrealDB v2.2.8 surfaces concurrent UNIQUE-key CREATEs as either
    // a unique-index violation or a commit-time read/write conflict;
    // both are caught by retryOnUniqueViolation. The retry's second
    // SELECT picks up the racing committer's row.
    return retryOnUniqueViolation(async () => {
      const fast = await this.lookupExternalRef(db, key);
      if (fast) return fast;

      const content = factory();
      const result = await runTransaction<{ id: unknown } | null>(db, (tx) => {
        tx.bind('content', content);
        tx.bind('key', key);
        tx.add('LET $new = (CREATE ONLY knowledge_entity CONTENT $content)');
        tx.add('CREATE entity_external_ref CONTENT { key: $key, entity: $new.id }');
        tx.add('RETURN $new');
      });
      return String(result?.id);
    });
  }

  private async lookupExternalRef(db: Surreal, key: string): Promise<string | null> {
    const arr = await queryRows<unknown>(
      db,
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    return arr[0] ? String(arr[0]) : null;
  }

  async resolveOrCreateNamedEntity({
    db,
    e,
    hint,
    _contextRef,
    incomingFacts = [],
  }: {
    db: Surreal;
    e: { name: string; type: string; canonical?: string | undefined };
    hint: { vertical: string; id: string; role?: string } | undefined;
    _contextRef: { vertical: string };
    incomingFacts?: string[];
  }): Promise<string> {
    // INGEST_CONFUSABLES_CHECK (Tier 3, default off): a homoglyph/mixed-
    // script RISK SIGNAL over the entity name, logged for review. It NEVER
    // blocks resolution and NEVER auto-merges — off ⇒ nothing computed.
    this.flagConfusables(e.name);

    // 1. Caller hint wins — same atomic upsert as fact ingest.
    if (hint) {
      const hintKey = externalRefKey(hint.vertical, hint.id);
      // Tier 3 reversible audit: a keyed reuse is deterministic (caller-
      // authoritative externalRef), but still logged so the merge trail is
      // complete. Existence is pre-checked ONLY under the flag (off ⇒ no
      // extra query, byte-identical).
      await this.auditExternalRefReuse(db, hintKey, e);
      return this.upsertEntityByExternalRef(db, hintKey, () => ({
        type: this.normalizeEntityType(e.type),
        canonicalName: e.canonical ?? e.name,
        aliases: [e.name],
        externalRefs: { [hintKey]: hint.id },
      }));
    }

    // 2. Canonical-name match. Hits `entity_canonical_lc_idx` directly
    // via the stored `canonicalNameLc` VALUE field — no per-row
    // `string::lowercase()` evaluation needed. Two concurrent ingests
    // of the same name can still both miss and both create; we accept
    // the rare alias-only dup (same legal entity, two records) since
    // name canonicalisation is heuristic. Identity merge via
    // ingestLink consolidates downstream.
    const target = (e.canonical ?? e.name).toLowerCase();
    // This is the tenant-GLOBAL naming path (mention/document ingest never
    // stamps a userId). Pin `userId IS NONE` so a same-named PERSONAL
    // entity never matches — otherwise global facts attach to a user's
    // private entity and leak its identity (externalRefs, canonicalName)
    // onto the global surface. Mirrors the scope fence on the embedding
    // resolver (entity-resolver.service.ts).
    const nRow = await queryFirst<{ id: unknown }>(
      db,
      `SELECT id FROM knowledge_entity
       WHERE (canonicalNameLc = $name
          OR aliases CONTAINS $rawName)
          AND userId IS NONE
       LIMIT 1`,
      { name: target, rawName: e.name },
    );
    if (nRow) {
      // Tier 3 reversible audit: an exact canonical/alias reuse is
      // deterministic, but logged so every reuse is traceable/reversible.
      await this.auditKeyedReuse(db, String(nRow.id), {
        mention: e.name,
        type: this.normalizeEntityType(e.type),
        matchKind: 'exact',
      });
      return String(nRow.id);
    }

    // 2a. Article-insensitive reuse (INGEST_ARTICLE_NORMALIZATION, default
    // off). The extractor coins entity names with and without a leading
    // English article across turns ("the office lease" vs "office lease"),
    // splitting ONE referent into two entities — and every slot-keyed
    // consumer downstream (conflict formation, timelines, competing pairs)
    // goes blind to the collision. The lookup is widened to the leading-
    // article VARIANTS of the name (stripped + the/a/an re-prefixed); the
    // stored canonicalName is never rewritten, and a UNIQUE match only —
    // two same-named-modulo-article entities existing already is exactly
    // the ambiguity we refuse to guess about. Same tenant-global fence.
    if (envFlagEnabled(process.env.INGEST_ARTICLE_NORMALIZATION)) {
      const variants = articleNameVariants(target);
      if (variants.length > 0) {
        const vRows = await queryRows<{ id: unknown }>(
          db,
          `SELECT id FROM knowledge_entity
           WHERE canonicalNameLc IN $variants
             AND userId IS NONE
           LIMIT 2`,
          { variants },
        );
        if (vRows.length === 1 && vRows[0]) {
          await this.auditKeyedReuse(db, String(vRows[0].id), {
            mention: e.name,
            type: this.normalizeEntityType(e.type),
            matchKind: 'article-variant',
          });
          return String(vRows[0].id);
        }
      }
    }

    // 2b. Code-identifier alias resolution (INGEST_CODE_ALIAS_RESOLUTION,
    // default off). A module mentioned by file path and by the symbol it
    // defines is ONE entity; the path↔symbol mapping is a deterministic
    // naming convention, so it resolves here — BEFORE the probabilistic
    // inline resolver — with no embeddings and no LLM. On a unique match
    // the existing entity is reused (and the new surface stamped into its
    // aliases); anything ambiguous or not clearly code-shaped falls
    // through to create-new. Same tenant-global fence as step 2.
    const viaCodeAlias = await this.resolveByCodeAlias(db, e);
    if (viaCodeAlias) return viaCodeAlias;

    // 3. Inline entity resolution (graphiti-style, opt-in). Before minting
    // a new entity, look for a near-duplicate that already exists and let
    // an LLM judge confirm same-as using the incoming facts. A confirmed
    // match reuses the existing entity, so the duplicate is never created.
    // Falls through to create-new when disabled, no match, or any error.
    if (this.entityResolver?.isEnabled()) {
      const resolved = await this.entityResolver.resolveByName({
        db,
        name: e.name,
        type: this.normalizeEntityType(e.type),
        incomingFacts,
      });
      if (resolved) return resolved;
    }

    const created = await dbCreate<{ id: unknown }>(db, 'knowledge_entity', {
      type: this.normalizeEntityType(e.type),
      canonicalName: e.canonical ?? e.name,
      aliases: this.seedAliases(e),
      externalRefs: {},
    });
    return String(created?.id);
  }

  async resolveOrCreateBareRef(db: Surreal, ref: EntityRef): Promise<string> {
    if ('entityId' in ref && ref.entityId) {
      return ref.entityId.includes(':') ? ref.entityId : `knowledge_entity:${ref.entityId}`;
    }
    const r = ref as { vertical: string; id: string };
    const refKey = externalRefKey(r.vertical, r.id);
    return this.upsertEntityByExternalRef(db, refKey, () => ({
      type: 'other',
      canonicalName: r.id,
      externalRefs: { [refKey]: r.id },
    }));
  }

  private normalizeEntityType(t: string): string {
    const allowed = ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'];
    return allowed.includes(t) ? t : 'other';
  }

  /**
   * INGEST_CODE_ALIAS_RESOLUTION (default off): deterministic alias-aware
   * resolution for code identifiers, both directions:
   *   - incoming PATH ("src/gateway/webhook-dispatcher.ts") → derive the
   *     conventional symbol ("WebhookDispatcher") and match it against
   *     existing canonical names / aliases;
   *   - incoming SYMBOL → scan for an existing path-named entity whose
   *     derived symbol equals it exactly.
   * Exact-normalized matches only, and only a UNIQUE match is reused — two
   * distinct candidates mean the identity is ambiguous and a fresh entity
   * is minted instead. CREATION-TIME reuse only: two twins that already
   * exist are never merged retroactively (that stays with the dreams
   * dedup). Scope-local by construction: every query runs on the tenant's
   * own DB (withCompany) and pins `userId IS NONE`, mirroring step 2 — a
   * same-named personal entity never matches. NEVER throws: any failure
   * falls through to create-new, resolution must not block ingest. The
   * flag is read per-call so a live flip lands without restart; off ⇒
   * byte-identical (nothing computed, no extra query).
   */
  private async resolveByCodeAlias(
    db: Surreal,
    e: { name: string; type: string; canonical?: string | undefined },
  ): Promise<string | null> {
    if (!envFlagEnabled(process.env.INGEST_CODE_ALIAS_RESOLUTION)) return null;
    try {
      const target = e.canonical ?? e.name;
      const symbol = symbolAliasForPath(target);
      if (symbol !== null) {
        return await this.reuseSymbolEntityForPath(db, { pathName: target, symbol, e });
      }
      if (isCodeSymbolShaped(target)) return await this.reusePathEntityForSymbol(db, target, e);
      return null;
    } catch (err) {
      this.logger.warn(
        `[ingest.code_alias] resolution failed for "${e.name}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Forward direction: an incoming code PATH reuses the entity already
   *  known by the derived symbol (canonical name or alias, exact
   *  normalized match, unique). */
  private async reuseSymbolEntityForPath(
    db: Surreal,
    p: { pathName: string; symbol: string; e: { name: string; type: string } },
  ): Promise<string | null> {
    const { pathName, symbol, e } = p;
    const rows = await queryRows<{ id: unknown }>(
      db,
      `SELECT id FROM knowledge_entity
        WHERE (canonicalNameLc = $sym OR aliases CONTAINS $symRaw)
          AND userId IS NONE
          AND mergedInto IS NONE
        LIMIT 2`,
      { sym: symbol.toLowerCase(), symRaw: symbol },
    );
    const ids = [...new Set(rows.map((r) => String(r.id)))];
    if (ids.length !== 1) {
      if (ids.length > 1) {
        this.logger.warn(
          `[ingest.code_alias] "${pathName}" derives "${symbol}" but ` +
            `${ids.length} entities carry that name — ambiguous, creating new`,
        );
      }
      return null;
    }
    const entityId = ids[0]!;
    await this.stampAlias(db, entityId, pathName);
    await this.auditKeyedReuse(db, entityId, {
      mention: e.name,
      type: this.normalizeEntityType(e.type),
      matchKind: 'exact', // deterministic exact match on the derived alias
    });
    this.logger.log(
      `[ingest.code_alias] reused ${entityId} for path "${pathName}" (symbol "${symbol}")`,
    );
    return entityId;
  }

  /** Reverse direction: an incoming PascalCase SYMBOL reuses the entity
   *  already known by a code path whose derived symbol equals it. Needle
   *  candidates are verified exactly by re-deriving, and only a unique
   *  verified entity is reused. */
  private async reusePathEntityForSymbol(
    db: Surreal,
    symbol: string,
    e: { name: string; type: string },
  ): Promise<string | null> {
    const matched = new Set<string>();
    for (const needle of pathNeedlesForSymbol(symbol)) {
      const rows = await queryRows<{ id: unknown; canonicalName: string }>(
        db,
        `SELECT id, canonicalName FROM knowledge_entity
          WHERE string::contains(canonicalNameLc, $needle)
            AND userId IS NONE
            AND mergedInto IS NONE
          LIMIT $k`,
        { needle, k: 16 },
      );
      for (const r of rows) {
        if (symbolAliasForPath(String(r.canonicalName)) === symbol) matched.add(String(r.id));
      }
      if (matched.size > 1) break; // already ambiguous — stop scanning
    }
    if (matched.size !== 1) {
      if (matched.size > 1) {
        this.logger.warn(
          `[ingest.code_alias] symbol "${symbol}" derives from ${matched.size} ` +
            `existing path entities — ambiguous, creating new`,
        );
      }
      return null;
    }
    const entityId = [...matched][0]!;
    await this.stampAlias(db, entityId, symbol);
    await this.auditKeyedReuse(db, entityId, {
      mention: e.name,
      type: this.normalizeEntityType(e.type),
      matchKind: 'exact', // deterministic exact match via derived symbol
    });
    this.logger.log(`[ingest.code_alias] reused ${entityId} for symbol "${symbol}"`);
    return entityId;
  }

  /** Append the newly-seen surface to the reused entity's aliases so the
   *  NEXT mention of it hits the step-2 exact match directly. Best-effort:
   *  a stamp failure never blocks resolution (the reuse already stands). */
  private async stampAlias(db: Surreal, entityId: string, alias: string): Promise<void> {
    try {
      await db.query(`UPDATE $id SET aliases = array::union(aliases ?? [], $add)`, {
        id: new StringRecordId(`knowledge_entity:${idTailOf(entityId)}`),
        add: [alias],
      });
    } catch (err) {
      this.logger.warn(
        `[ingest.code_alias] alias stamp failed on ${entityId}: ${(err as Error).message}`,
      );
    }
  }

  /** Aliases for a freshly-minted entity. Under INGEST_CODE_ALIAS_RESOLUTION
   *  a path-named entity is born carrying its derived symbol alias, so the
   *  later symbol phrasing resolves via the step-2 exact alias match. Flag
   *  off ⇒ exactly the pre-flag `[e.name]`. */
  private seedAliases(e: { name: string; canonical?: string | undefined }): string[] {
    const aliases = [e.name];
    if (envFlagEnabled(process.env.INGEST_CODE_ALIAS_RESOLUTION)) {
      const symbol = symbolAliasForPath(e.canonical ?? e.name);
      if (symbol !== null && !aliases.includes(symbol)) aliases.push(symbol);
    }
    return aliases;
  }

  /** INGEST_CONFUSABLES_CHECK: log a homoglyph/mixed-script name for review.
   *  RISK SIGNAL ONLY — never blocks, never auto-merges. Off ⇒ no-op. */
  private flagConfusables(name: string): void {
    if (!envFlagEnabled(process.env.INGEST_CONFUSABLES_CHECK)) return;
    const risk = analyzeConfusables(name);
    if (!risk.flagged) return;
    this.logger.warn(
      `[ingest.confusables] entity name "${name}" is a homoglyph risk ` +
        `(skeleton="${risk.skeleton}", mixedScript=${risk.mixedScript}, ` +
        `hasConfusables=${risk.hasConfusables}) — flagged for review; ` +
        'resolution NOT blocked',
    );
  }

  /** Audit a deterministic keyed reuse to entity_merge_log (0102), gated on
   *  MULTILINGUAL_ENTITY_REVERSIBLE. No-op when the resolver isn't wired or
   *  the flag is off. */
  private async auditKeyedReuse(
    db: Surreal,
    targetEntity: string,
    meta: { mention: string; type: string; matchKind: 'exact' | 'externalRef' | 'article-variant' },
  ): Promise<void> {
    if (!this.entityResolver?.isReversible()) return;
    await this.entityResolver.recordMerge(db, {
      mention: meta.mention,
      type: meta.type,
      targetEntity,
      verdict: 'same',
      cosine: 1,
      matchKind: meta.matchKind,
      decision: 'reused',
    });
  }

  /** Audit an externalRef/hint reuse: only a PRE-EXISTING keyed entity is a
   *  reuse (a fresh create is not), so existence is checked first — but only
   *  under the reversible flag, so the off path adds no query. */
  private async auditExternalRefReuse(
    db: Surreal,
    hintKey: string,
    e: { name: string; type: string },
  ): Promise<void> {
    if (!this.entityResolver?.isReversible()) return;
    const existing = await this.lookupExternalRef(db, hintKey);
    if (!existing) return;
    await this.auditKeyedReuse(db, existing, {
      mention: e.name,
      type: this.normalizeEntityType(e.type),
      matchKind: 'externalRef',
    });
  }
}
