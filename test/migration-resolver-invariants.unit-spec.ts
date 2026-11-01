/**
 * GATE: pin the load-bearing invariants of the LIVE write resolver —
 * fn::resolve_fact until 0177, fn::settle_fact since (#830: a new name,
 * because stored-function signatures are append-only across a rolling
 * deploy; the old body stays for the image rolling out from).
 *
 * fn::resolve_fact is OVERWRITE'd by many migrations; the deployed
 * definition is whatever the highest-numbered migration left. Twice now a
 * migration authored as a diff against a STALE baseline silently dropped
 * an earlier fix (0018 re-added retractedAt that 0014 removed; 0033
 * reverted 0022's learned source-trust). This test fails CI if the head
 * definition loses any accumulated fix — so the next OVERWRITE author
 * can't re-drop one unnoticed.
 *
 * If you intentionally change resolve_fact semantics, update the
 * invariants here in the same commit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');

function headResolveFactMigration(): { name: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.surql$/.test(f))
    .sort();
  let head: { name: string; body: string } | null = null;
  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    // The trailing `(` pins the exact function — otherwise the batch wrapper
    // `fn::resolve_facts(` (migration 0071) substring-matches and hijacks head.
    if (
      text.includes('DEFINE FUNCTION OVERWRITE fn::resolve_fact(') ||
      text.includes('DEFINE FUNCTION OVERWRITE fn::settle_fact(')
    ) {
      head = { name: f, body: text };
    }
  }
  if (!head) throw new Error('no migration defines the write resolver');
  return head;
}

/** Strip SQL `-- ...` comment lines so assertions hit real statements. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** Extract the supersede FOR-loop body (sans comments). */
function supersedeLoop(body: string): string {
  const start = body.indexOf('FOR $loser IN');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('RETURN {', start);
  return stripComments(body.slice(start, end));
}

describe('GATE: live fn::resolve_fact invariants', () => {
  const head = headResolveFactMigration();

  it(`uses the latest migration (${head.name}) as the resolver head`, () => {
    expect(head.name >= '0034_supersede_no_retracted_at_fix.surql').toBe(true);
  });

  it('snapshots the learned, domain-scoped source trust onto the fact (0044/0045)', () => {
    // Since #830 trust is provenance, not a vote: no weighted score reads
    // it, but the fact still freezes what the resolver believed about the
    // source (fn::source_trust_scoped — 0045's domain ladder).
    expect(head.body).toContain('learnedTrust: fn::source_trust_scoped($src_key, $predicate)');
    expect(head.body).not.toMatch(/\$w_source_trust/);
  });

  it('decides by valid time, with no weighted margin or reject floor (#830)', () => {
    expect(head.body).not.toContain('$margin_for_supersede');
    expect(head.body).not.toContain('$reject_threshold');
    expect(head.body).toContain('validFrom < $valid_from');
  });

  it('snapshots priorValidUntil on supersede (revive-after-retract depends on it)', () => {
    expect(supersedeLoop(head.body)).toContain('priorValidUntil = $loser.validUntil');
  });

  it('does NOT set retractedAt on a natural supersede (migration 0014 contract)', () => {
    // The exact regression 0033/0034 fixed: a natural supersede must not
    // be marked retracted.
    expect(supersedeLoop(head.body)).not.toContain('retractedAt = time::now()');
  });

  it('keeps the superseded sentinel revive + calibration key on', () => {
    const loop = supersedeLoop(head.body);
    expect(loop).toContain("retractionReason = 'superseded'");
    expect(loop).toContain('supersededBy = $new.id');
  });

  it('keeps the corroboration branch keyed on ORIGIN, not recorder (0050)', () => {
    // 0050 decides independence by the document origin, not the source key.
    // A migration authored against a pre-0050 baseline would silently drop
    // the origin key and re-introduce false "two independent sources"
    // corroboration between indexers reading one document.
    expect(head.body).toContain('LET $origin_key = fn::origin_key_of($source)');
    expect(head.body).toContain("status = 'corroborating'");
    expect(head.body).toContain('fn::origin_key_of(source) != $origin_key');
  });

  it('counts corroboration as DISTINCT origins, not events (0051)', () => {
    // 0051 derives corroboration.count from the deduped origin set so one
    // source repeating itself cannot inflate the read-time γ boost. A stale
    // baseline would reinstate the unconditional `corroboration.count + 1`.
    // The branch's own return — 0165's ended-value branch returns
    // CORROBORATED earlier in the body.
    const start = head.body.indexOf('IF $corroborated != NONE');
    const corroborationBranch = stripComments(
      head.body.slice(start, head.body.indexOf("outcome: 'CORROBORATED'", start)),
    );
    expect(corroborationBranch).toContain('count: array::len(array::union(');
    expect(corroborationBranch).not.toContain('corroboration.count + 1');
  });
});
