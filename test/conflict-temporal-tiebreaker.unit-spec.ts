import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FactResolverService,
  directSelfUpdateCue,
  hasUpdateCue,
} from '../src/ingest/fact-resolver.service';
import {
  TEMPORAL_TIEBREAK_WINDOW_MAX_MS,
  clampTemporalTiebreakWindowMs,
} from '../src/ingest/conflict-resolver';

/**
 * CONFLICT_TEMPORAL_TIEBREAKER — the succession tiebreaker for the
 * bitemporal close-margin doctrine (migration 0129).
 *
 * The regression (memory-fitness run mfmtqn2jiq, 28/30 → 23/30): the
 * #444 promotion + #455 slot-exact floor route mention-path
 * single-value slots into the margin doctrine, where batch-shaped
 * corpora score every write identically (margin ~0) and every same-slot
 * pairing lands COMPETING — genuine temporal updates included, so
 * honest serving abstains on settled current values. Measured live,
 * neither validFrom separation (the s07 contradiction arms sit 6 days
 * apart, the launch update 16, the payout-cutoff contradiction 15, the
 * killing update pairing 25 MINUTES) nor origin identity (one recorder
 * per corpus) separates UPDATE from CONTRADICTION; the update-language
 * cue does. Pins here:
 *  - the cue matrix over the measured corpus strings (updates hit,
 *    contradiction arms miss);
 *  - the window clamp (default 0 = strict event order);
 *  - the resolver seam: flag off → byte-identical params; armed only
 *    for mention-path 'bitemporal' resolves; the direct typed path
 *    never computes a cue;
 *  - the fn-side doctrine matrix as text invariants on the 0129 head
 *    (the migration-resolver-invariants harness): 'bitemporal'-only,
 *    no fire on a clear margin winner, NONE window ⇒ off, cue must be
 *    true, strictly-earlier-beyond-window losers with the
 *    missing-validFrom guard, 0085-style partition, and the audit
 *    stamp. The live behavior matrix is exercised against the real fn
 *    in the acceptance run.
 */
describe('CONFLICT_TEMPORAL_TIEBREAKER', () => {
  afterEach(() => {
    delete process.env.CONFLICT_TEMPORAL_TIEBREAKER;
    delete process.env.CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS;
    delete process.env.CONFLICT_MENTION_FACT_SLOT;
    delete process.env.CONFLICT_DIRECT_FACT_SLOT;
  });

  describe('hasUpdateCue — deterministic succession markers (measured corpus strings)', () => {
    it.each([
      // memory-fitness update chain (must fire — the regression cases)
      'now NATS JetStream',
      'the job queue backend for ledger-sync is now NATS JetStream',
      'moves from 2026-04-15 to 2026-05-06',
      'deploys to AWS ECS Fargate instead of Fly.io',
      'every enqueue in ledger-sync now carries idempotencyKey = sha256(payoutId + attemptDate)',
      'This replaces the fixed 3-retries-30s policy from 2026-03-10',
      'Redis Streams is no longer the queue',
      // generic succession language (transition-shaped corpora)
      'switched to PostgreSQL',
      'moved to Berlin',
      'renamed the company to Acme Labs',
      'my work laptop is now a MacBook Pro',
      'I do not ride the bike anymore',
    ])('cue: %s', (s) => {
      expect(hasUpdateCue(s)).toBe(true);
    });

    it.each([
      // s07 contradiction arms — MUST miss: disputing the record is not
      // narrating succession ("actually" is a dispute marker).
      'until December 2026',
      'ends in September 2026',
      'Facilities says the office lease actually ends in September 2026.',
      'The office lease runs until December 2026.',
      // bare values / assertions (the direct-path pair objects included)
      '2026-05-06',
      '17:00 UTC',
      'Redis Streams',
      'duplicate payout bug',
      'the hot path',
      'package manager is pnpm',
      // word-boundary traps for the 'now' marker
      'a renowned engineer',
      'nowhere near done',
      // 'registered to me' must not match the *_to patterns
      'registered to me',
    ])('no cue: %s', (s) => {
      expect(hasUpdateCue(s)).toBe(false);
    });
  });

  describe('clampTemporalTiebreakWindowMs', () => {
    it('passes sane values through', () => {
      expect(clampTemporalTiebreakWindowMs(0)).toBe(0);
      expect(clampTemporalTiebreakWindowMs(90_000)).toBe(90_000);
    });
    it('clamps negatives and non-finite to 0 (strict event order)', () => {
      expect(clampTemporalTiebreakWindowMs(-5)).toBe(0);
      expect(clampTemporalTiebreakWindowMs(Number.NaN)).toBe(0);
      // Non-finite is nonsense input — strictness (0), not the ceiling.
      expect(clampTemporalTiebreakWindowMs(Number.POSITIVE_INFINITY)).toBe(0);
    });
    it('caps at 365d', () => {
      expect(clampTemporalTiebreakWindowMs(TEMPORAL_TIEBREAK_WINDOW_MAX_MS + 1)).toBe(
        TEMPORAL_TIEBREAK_WINDOW_MAX_MS,
      );
    });
  });

  // ── resolver seam: what fn::resolve_fact receives ──────────────────
  function make(
    resolveRow: Record<string, unknown> = { factId: 'knowledge_fact:x', outcome: 'INSERTED' },
  ) {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
        queries.push({ sql, params });
        return [resolveRow];
      }),
    };
    const factEmbedding = {
      embed: jest.fn(async () => [0.1]),
      writeAltEmbeddingIfHype: jest.fn(async () => {}),
    };
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn((_c: string, predicate: string) =>
        predicate === 'status'
          ? { predicateId: 'status', semantics: 'single_active' }
          : { predicateId: '__default__', semantics: 'append_only' },
      ),
    };
    const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
    return { svc, db, queries };
  }

  function input(predicate: string, opts: { recordOutcomeMetric?: boolean; object?: string } = {}) {
    return {
      companyId: 'co_x',
      entityId: 'knowledge_entity:e1',
      predicate,
      object: opts.object ?? 'now NATS JetStream',
      confidence: 0.9,
      validFrom: new Date('2026-03-18T09:35:00Z'),
      source: {},
      precomputedEmbedding: [0.1, 0.2],
      userId: 'memfit-user',
      ...(opts.recordOutcomeMetric !== undefined
        ? { recordOutcomeMetric: opts.recordOutcomeMetric }
        : {}),
    };
  }

  const resolveCalls = (queries: Array<{ sql: string; params: Record<string, unknown> }>) =>
    queries.filter((q) => q.sql.includes('fn::resolve_fact('));

  it('flag off: params byte-identical (unset vs "0"), tiebreak args never bound', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const unset = make();
    await unset.svc.resolve(unset.db as never, input('status'));
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '0';
    const off = make();
    await off.svc.resolve(off.db as never, input('status'));

    const unsetParams = resolveCalls(unset.queries)[0]!.params;
    expect(unsetParams.tiebreak_window_ms).toBeUndefined();
    expect(unsetParams.update_cue).toBeUndefined();
    expect(resolveCalls(off.queries)[0]!.params).toEqual(unsetParams);
  });

  it('armed: mention path + promoted bitemporal + cue object binds window (default 0) and cue=true', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '1';
    const { svc, db, queries } = make();
    await svc.resolve(db as never, input('status'));
    const params = resolveCalls(queries)[0]!.params;
    expect(params.semantics).toBe('bitemporal');
    expect(params.tiebreak_window_ms).toBe(0);
    expect(params.update_cue).toBe(true);
  });

  it('armed + cue-less object: window bound, cue=false (fn keeps the COMPETING doctrine)', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '1';
    const { svc, db, queries } = make();
    await svc.resolve(
      db as never,
      // The s07 contradiction arm — must never attest a succession cue.
      input('status', { object: 'ends in September 2026' }),
    );
    const params = resolveCalls(queries)[0]!.params;
    expect(params.tiebreak_window_ms).toBe(0);
    expect(params.update_cue).toBe(false);
  });

  it('window env is read into ConflictConfig and clamped', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS = '90000';
    const bounded = make();
    await bounded.svc.resolve(bounded.db as never, input('status'));
    expect(resolveCalls(bounded.queries)[0]!.params.tiebreak_window_ms).toBe(90_000);

    process.env.CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS = '-5';
    const negative = make();
    await negative.svc.resolve(negative.db as never, input('status'));
    expect(resolveCalls(negative.queries)[0]!.params.tiebreak_window_ms).toBe(0);
  });

  it('direct typed path: self-update by the act — cue=true for a conversation-grounded slot re-write', async () => {
    // The measured d1-launch abstention: the T3 conflict note over the
    // direct pilot_launch_date self-revision pair refused a settled
    // current value. A typed re-write of one's own slot attests
    // succession by the act itself.
    process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, {
      ...input('pilot_launch_date', { recordOutcomeMetric: true, object: '2026-05-06' }),
      source: { evidence: [{ kind: 'conversation', ref: 'c3', note: 'launch slip' }] },
    });
    expect(out.semantics).toBe('bitemporal'); // direct __default__ promotion
    const params = resolveCalls(queries)[0]!.params;
    expect(params.tiebreak_window_ms).toBe(0);
    expect(params.update_cue).toBe(true);
  });

  it('direct typed path: an external-artifact-backed claim attests NO succession (D6 shape protected)', async () => {
    // The docs-v2.3 side of the payout-cutoff pair: an independent
    // standing voice — the close-margin → COMPETING doctrine stands.
    process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '1';
    const { svc, db, queries } = make();
    await svc.resolve(db as never, {
      ...input('payout_cutoff', { recordOutcomeMetric: true, object: '16:30 UTC' }),
      source: { evidence: [{ kind: 'document', ref: 'meridian-api-docs-v2.3' }] },
    });
    const params = resolveCalls(queries)[0]!.params;
    expect(params.tiebreak_window_ms).toBe(0);
    expect(params.update_cue).toBe(false);
  });

  describe('directSelfUpdateCue', () => {
    it('true for conversation/message evidence and for ungrounded records', () => {
      expect(directSelfUpdateCue({ evidence: [{ kind: 'conversation', ref: 'c1' }] })).toBe(true);
      expect(directSelfUpdateCue({ evidence: [{ kind: 'message', ref: 'c2:t05' }] })).toBe(true);
      expect(directSelfUpdateCue({ recorder: 'mcp_agent' })).toBe(true);
      expect(directSelfUpdateCue(undefined)).toBe(true);
    });
    it('false when ANY evidence entry cites an external artifact (document/url)', () => {
      expect(directSelfUpdateCue({ evidence: [{ kind: 'document', ref: 'docs-v2.3' }] })).toBe(
        false,
      );
      expect(
        directSelfUpdateCue({
          evidence: [{ kind: 'message' }, { kind: 'url', ref: 'https://x' }],
        }),
      ).toBe(false);
    });
  });

  it('mention path + append_only bulk: not armed', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    process.env.CONFLICT_TEMPORAL_TIEBREAKER = '1';
    const { svc, db, queries } = make();
    await svc.resolve(db as never, input('interacted_with'));
    const params = resolveCalls(queries)[0]!.params;
    expect(params.semantics).toBe('append_only');
    expect(params.tiebreak_window_ms).toBeUndefined();
    expect(params.update_cue).toBeUndefined();
  });

  // ── fn-side doctrine matrix — text invariants on the 0129 head ─────
  describe('migration 0129 doctrine invariants', () => {
    const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');
    const head = (() => {
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{4}_.+\.surql$/.test(f))
        .sort();
      let last: { name: string; body: string } | null = null;
      for (const f of files) {
        const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
        if (text.includes('DEFINE FUNCTION OVERWRITE fn::resolve_fact(')) {
          last = { name: f, body: text };
        }
      }
      if (!last) throw new Error('no migration defines fn::resolve_fact');
      return last;
    })();

    const stripComments = (sql: string): string =>
      sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n');

    it('0129 (or later, carrying the tiebreaker) is the resolver head', () => {
      expect(head.name >= '0129_temporal_margin_tiebreaker.surql').toBe(true);
      expect(head.body).toContain('$tiebreak_window_ms: option<number>');
      expect(head.body).toContain('$update_cue: option<bool>');
    });

    it("fires only for 'bitemporal', never on a clear margin winner, and only when window+cue are bound", () => {
      const body = stripComments(head.body);
      const tb = body.slice(body.indexOf('LET $tb_losers'), body.indexOf('LET $tb_fire'));
      expect(tb).toContain("$semantics = 'bitemporal'");
      expect(tb).toContain('$margin_win = false');
      expect(tb).toContain('$tiebreak_window_ms != NONE');
      expect(tb).toContain('$update_cue = true');
    });

    it('losers are strictly-earlier-beyond-window with the missing-validFrom and artifact guards', () => {
      const body = stripComments(head.body);
      const tb = body.slice(body.indexOf('LET $tb_losers'), body.indexOf('LET $tb_fire'));
      // missing validFrom → not a loser → stays on the COMPETING path
      expect(tb).toContain('validFrom != NONE');
      // strictly later beyond the window: validFrom + window < $valid_from
      // (window 0 ⇒ strict '<', so identical stamps still COMPETE)
      expect(tb).toContain(
        'validFrom + duration::from_millis(<int> $tiebreak_window_ms) < $valid_from',
      );
      // an incumbent citing an external artifact (document/url
      // evidence) is a standing independent voice — recency never
      // closes it (the D6 payout-cutoff shape, order-robust).
      expect(tb).toContain("'document' NOT IN (source.evidence.kind ?? [])");
      expect(tb).toContain("'url' NOT IN (source.evidence.kind ?? [])");
    });

    it('partitions 0085-style (losers close, the rest flip to competing) and joins $supersede by OR', () => {
      const body = stripComments(head.body);
      expect(body).toContain('ELSE IF $tb_fire THEN\n        $tb_losers');
      expect(body).toContain('WHERE id NOT IN $tb_losers.id');
      const supersede = body.slice(body.indexOf('LET $supersede'), body.indexOf('LET $loser_ids'));
      expect(supersede).toContain('OR $tb_fire');
    });

    it('stamps the audit trail on the winner only when fired (flag-off trace shape unchanged)', () => {
      const body = stripComments(head.body);
      const stamp = body.indexOf('conflictTrace.temporalTiebreak');
      expect(stamp).toBeGreaterThan(-1);
      const guard = body.lastIndexOf('IF $tb_fire {', stamp);
      expect(guard).toBeGreaterThan(-1);
    });

    it('re-admits stuck COMPETING rows to the pool ONLY for an armed, cue-bearing bitemporal call (F3 extension)', () => {
      // Measured on the first acceptance run: without this, a competing
      // pair in a promoted slot is PERMANENT — the active-only pool
      // makes it invisible and every later update INSERTs past it, so
      // serving abstains forever. The widening must be gated on
      // window+cue so every other call sees the byte-identical pool.
      const body = stripComments(head.body);
      const candidates = body.slice(
        body.indexOf('LET $candidates'),
        body.indexOf('LET $competing'),
      );
      expect(candidates).toContain(
        "OR (status = 'competing' AND $semantics = 'bitemporal'\n               AND $tiebreak_window_ms != NONE AND $update_cue = true)",
      );
    });

    it('closes a same-origin exact restatement as corroborating, armed calls only, no count inflation', () => {
      // Measured live: corroboration requires a DIFFERENT origin, so a
      // same-origin repeat of the SAME object fell to the ~0 margin and
      // produced a COMPETING pair of two identical values — phantom
      // conflict noise. The dedup must be gated on the armed-call
      // marker, keep exact `object = $object` equality, same-origin
      // (`= $origin_key`, the mirror of corroboration's `!=`), and must
      // NOT touch the incumbent's corroboration counters.
      const body = stripComments(head.body);
      const at = body.indexOf('LET $restated');
      expect(at).toBeGreaterThan(-1);
      const branch = body.slice(body.lastIndexOf('IF $semantics', at), body.indexOf('};', at));
      expect(branch).toContain('$tiebreak_window_ms != NONE');
      expect(branch).toContain('object = $object');
      expect(branch).toContain('fn::origin_key_of(source) = $origin_key');
      expect(branch).not.toContain('corroboration =');
      // The true (different-origin) corroboration branch still runs FIRST.
      expect(body.indexOf('fn::origin_key_of(source) != $origin_key')).toBeLessThan(at);
    });

    it('keeps fn::resolve_facts in lockstep (27-arg mapper binds the two new args)', () => {
      const body = stripComments(head.body);
      const mapper = body.slice(body.indexOf('fn::resolve_facts'));
      expect(mapper).toContain('$cfg.tiebreak_window_ms, $f.update_cue');
    });
  });
});
