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
import { scopeFenceSql } from '../auth/scope-visibility';
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
 *
 * Plus ONE non-minting reader — `resolveExistingByName` — for DERIVED
 * surfaces that must point at entities the graph already knows without
 * ever creating one (the scene plane's 0106 `entityIds` backlinks). It
 * shares this service precisely so there is one place where the corpus's
 * naming conventions (exact canonical/alias, leading articles, code
 * path↔symbol) are interpreted, instead of a second, drifting copy.
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
    return this.upsertEntityByExternalRef(db, refKey, {
      factory: () => ({
        type: 'other',
        canonicalName: ref.id,
        externalRefs: { [refKey]: ref.id },
        // G6 step 1: mirror the per-user scope as a scope tag (0093) next
        // to the userId stamp. The named-entity path stays tenant-global
        // (no userId → the scope field DEFAULT [] holds).
        ...(userId ? { userId, scope: scopeForUser(userId) } : {}),
      }),
      // The ref id IS a name the caller chose for this thing; if the
      // graph already knows exactly that name, it is the same thing.
      //
      // TENANT-GLOBAL REFS ONLY, and this is load-bearing. 0055 gives a
      // user-scoped ref its OWN entity rather than hanging personal
      // facts off the shared node, and user-forget deletes that entity
      // (`entitiesDeleted`) — so adopting the tenant-global node for a
      // scoped ref would either orphan the erasure or point it at a
      // shared entity. `resolveExistingByName`'s fence is the search-lane
      // union (`userId IS NONE OR userId = $scopeUserId`), which is
      // correct for READING and too wide for MINTING, so the scoped case
      // keeps the historical mint instead of borrowing that fence.
      ...(userId === undefined
        ? { adopt: () => this.resolveExistingByName(db, { name: ref.id }) }
        : {}),
    });
  }

  /**
   * `adopt` is the identity check that used to be missing here. The
   * external-ref key is the ONLY thing this path consulted, so a
   * structured `entityRef {vertical, id}` minted a brand-new entity even
   * when the tenant already knew that exact name — the two ingest paths
   * used different identity keys and never met. Measured: one tenant
   * holding `Meridian` (coined by extraction) AND `meridian` (minted by
   * `/v1/ingest/fact` with `id: 'meridian'`) as separate entities, with
   * the payout-cutoff facts split across both, which is why the
   * competing-facts surface could not find the disagreement it was
   * holding.
   *
   * On a miss, an adopted id gets ONLY the ref row — the existing entity
   * is left exactly as it is (its canonicalName is never rewritten, the
   * `resolveExistingByName` rule). Returning null keeps the historical
   * mint. The lookup itself is unique-match-only and scope-fenced, so an
   * ambiguous or cross-scope name adopts nothing.
   */
  async upsertEntityByExternalRef(
    db: Surreal,
    key: string,
    opts: { factory: () => Record<string, unknown>; adopt?: () => Promise<string | null> },
  ): Promise<string> {
    // SurrealDB v2.2.8 surfaces concurrent UNIQUE-key CREATEs as either
    // a unique-index violation or a commit-time read/write conflict;
    // both are caught by retryOnUniqueViolation. The retry's second
    // SELECT picks up the racing committer's row.
    return retryOnUniqueViolation(async () => {
      const fast = await this.lookupExternalRef(db, key);
      if (fast) return fast;

      const adopted = opts.adopt ? await opts.adopt() : null;
      if (adopted) {
        // Ref row only. A UNIQUE violation here means a concurrent caller
        // claimed the same key — retryOnUniqueViolation re-reads it.
        await dbCreate(db, 'entity_external_ref', { key, entity: new StringRecordId(adopted) });
        return adopted;
      }

      const content = opts.factory();
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
      return this.upsertEntityByExternalRef(db, hintKey, {
        factory: () => ({
          type: this.normalizeEntityType(e.type),
          canonicalName: e.canonical ?? e.name,
          aliases: [e.name],
          externalRefs: { [hintKey]: hint.id },
        }),
        // Same identity check as the structured path: a hint says WHICH
        // key to file this under, not that the name is new. Without it
        // step 2's canonical-name match — the thing that would have found
        // the existing entity — is skipped whenever a hint is present.
        adopt: () => this.resolveExistingByName(db, { name: e.canonical ?? e.name }),
      });
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

  /**
   * RESOLVE-ONLY name lookup: the deterministic half of
   * `resolveOrCreateNamedEntity` with the minting, the alias stamping, the
   * merge-log audit and the probabilistic LLM judge all removed. Returns
   * an existing knowledge_entity id or null — it NEVER creates a row and
   * NEVER writes anything at all.
   *
   * WHO NEEDS THIS. A RECONSTRUCTION surface — the scene plane's
   * `entityIds` backlinks (0106, SCENES_ENTITY_LINKS) is the first — wants
   * to point at entities the graph already knows, and must not be able to
   * mint them: a scene is derived from turns that were already ingested,
   * so any entity it legitimately names was already created by the ingest
   * path. Letting a derived pass mint would make a summary a source of
   * truth and would let an LLM's paraphrase of a name ("the Lisbon trip")
   * become a permanent node nothing else references.
   *
   * MATCH LADDER — the same three deterministic steps the naming path
   * uses, in the same order, riding the SAME env flags so the corpus's
   * naming conventions are read identically wherever they are read:
   *   1. exact `canonicalNameLc` / `aliases` match;
   *   2. leading-article variants (INGEST_ARTICLE_NORMALIZATION);
   *   3. code path↔symbol convention (INGEST_CODE_ALIAS_RESOLUTION).
   * The probabilistic step 3 of the naming path (the embedding + LLM judge
   * resolver) is deliberately EXCLUDED: it exists to avoid minting a
   * duplicate at ingest time, and a low-confidence fuse is the wrong
   * trade-off for a backlink nobody asked for.
   *
   * UNIQUE MATCHES ONLY, at every step — including step 1, where the
   * minting path takes `LIMIT 1` because it must produce SOME id. Here two
   * same-named candidates mean the identity is ambiguous, and the honest
   * answer for a backlink is no link at all. `mergedInto IS NONE` excludes
   * entities already folded into another identity.
   *
   * SCOPE (0055 + 0093). `userId` is the scope key of the asking surface
   * when it has exactly ONE; undefined means it has none (or more than
   * one), and then ONLY tenant-global entities are visible — mirroring the
   * `userId IS NONE` pin the naming path uses, so a personal entity can
   * never be linked from a shared row. A scoped caller additionally sees
   * its OWN entities and nobody else's; the 0093 scope-tag fence ANDs
   * alongside (inert while SCOPE_TAGS_ENABLED is off, and it can only ever
   * narrow).
   *
   * NEVER THROWS: any failure returns null. A backlink is an enrichment,
   * never a reason to fail the pass that asked for it.
   */
  async resolveExistingByName(
    db: Surreal,
    e: { name: string },
    opts: { userId?: string | undefined } = {},
  ): Promise<string | null> {
    const raw = e.name.trim();
    if (raw === '') return null;
    const target = raw.toLowerCase();
    const fence = this.readFence(opts.userId);
    try {
      // 1. Exact canonical-name / alias match.
      const exact = await this.uniqueEntity(
        db,
        `SELECT id FROM knowledge_entity
          WHERE (canonicalNameLc = $name OR aliases CONTAINS $rawName)
            AND mergedInto IS NONE
            ${fence.clause}
          LIMIT 2`,
        { name: target, rawName: raw, ...fence.params },
      );
      if (exact) return exact;

      // 2. Leading-article variants (INGEST_ARTICLE_NORMALIZATION).
      if (envFlagEnabled(process.env.INGEST_ARTICLE_NORMALIZATION)) {
        const variants = articleNameVariants(target);
        if (variants.length > 0) {
          const viaArticle = await this.uniqueEntity(
            db,
            `SELECT id FROM knowledge_entity
              WHERE canonicalNameLc IN $variants
                AND mergedInto IS NONE
                ${fence.clause}
              LIMIT 2`,
            { variants, ...fence.params },
          );
          if (viaArticle) return viaArticle;
        }
      }

      // 3. Code path↔symbol convention (INGEST_CODE_ALIAS_RESOLUTION).
      return await this.resolveExistingByCodeAlias(db, raw, fence);
    } catch (err) {
      this.logger.warn(
        `[entity.resolve_only] lookup failed for "${raw}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The read fence for a resolve-only lookup: the 0055 userId rule plus
   * the 0093 scope-tag fence. No scope key ⇒ tenant-global rows only (the
   * naming path's `userId IS NONE` pin, verbatim); a scope key ⇒ its own
   * rows too, and never a third party's.
   */
  private readFence(userId: string | undefined): {
    clause: string;
    params: Record<string, unknown>;
  } {
    const scope = scopeFenceSql(userId, 'entityScopeTag');
    if (userId === undefined) {
      return { clause: `AND userId IS NONE ${scope.clause}`, params: { ...scope.params } };
    }
    return {
      clause: `AND (userId IS NONE OR userId = $scopeUserId) ${scope.clause}`,
      params: { scopeUserId: userId, ...scope.params },
    };
  }

  /** Run a 2-row probe and return the id only when it is UNAMBIGUOUS. */
  private async uniqueEntity(
    db: Surreal,
    sql: string,
    params: Record<string, unknown>,
  ): Promise<string | null> {
    const rows = await queryRows<{ id: unknown }>(db, sql, params);
    const ids = [...new Set(rows.map((r) => String(r.id)))];
    return ids.length === 1 ? ids[0]! : null;
  }

  /**
   * Read-only twin of `resolveByCodeAlias`: the same deterministic
   * path↔symbol convention, both directions, unique matches only — but it
   * never stamps the new surface into the reused entity's aliases. A
   * derived backlink must not mutate the entity it points at; the alias
   * seeding is the ingest path's job, where the surface was actually
   * observed as a name.
   */
  private async resolveExistingByCodeAlias(
    db: Surreal,
    name: string,
    fence: { clause: string; params: Record<string, unknown> },
  ): Promise<string | null> {
    if (!envFlagEnabled(process.env.INGEST_CODE_ALIAS_RESOLUTION)) return null;
    const symbol = symbolAliasForPath(name);
    if (symbol !== null) {
      return this.uniqueEntity(
        db,
        `SELECT id FROM knowledge_entity
          WHERE (canonicalNameLc = $sym OR aliases CONTAINS $symRaw)
            AND mergedInto IS NONE
            ${fence.clause}
          LIMIT 2`,
        { sym: symbol.toLowerCase(), symRaw: symbol, ...fence.params },
      );
    }
    if (!isCodeSymbolShaped(name)) return null;
    const matched = new Set<string>();
    for (const needle of pathNeedlesForSymbol(name)) {
      const rows = await queryRows<{ id: unknown; canonicalName: string }>(
        db,
        `SELECT id, canonicalName FROM knowledge_entity
          WHERE string::contains(canonicalNameLc, $needle)
            AND mergedInto IS NONE
            ${fence.clause}
          LIMIT $k`,
        { needle, k: 16, ...fence.params },
      );
      for (const r of rows) {
        if (symbolAliasForPath(String(r.canonicalName)) === name) matched.add(String(r.id));
      }
      if (matched.size > 1) break; // already ambiguous — stop scanning
    }
    return matched.size === 1 ? [...matched][0]! : null;
  }

  async resolveOrCreateBareRef(db: Surreal, ref: EntityRef): Promise<string> {
    if ('entityId' in ref && ref.entityId) {
      return ref.entityId.includes(':') ? ref.entityId : `knowledge_entity:${ref.entityId}`;
    }
    const r = ref as { vertical: string; id: string };
    const refKey = externalRefKey(r.vertical, r.id);
    return this.upsertEntityByExternalRef(db, refKey, {
      factory: () => ({
        type: 'other',
        canonicalName: r.id,
        externalRefs: { [refKey]: r.id },
      }),
      // Link endpoints get the same identity check: a relation drawn to
      // "meridian" must land on the Meridian the graph already has, or
      // the edge points at a node nothing else references.
      adopt: () => this.resolveExistingByName(db, { name: r.id }),
    });
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
