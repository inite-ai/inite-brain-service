/**
 * Shared shapes of the evidence battery — the fifth mechanical sibling of
 * test/eval/memory-fitness (first-person memory fitness),
 * test/eval/state-transitions (mutable world-state),
 * test/eval/domain-packs (installed industry packs) and
 * test/eval/code-memory (the builtin coding pack).
 *
 * This one isolates ONE claim: **bytes handed to the brain stay
 * accountable end to end** — upload → quarantine → processing run →
 * fragment → citation → signed-URL gateway → grants → GC → erasure. Every
 * assertion is mechanical (status codes, byte hashes, row counts); there
 * is NO LLM judge and, unlike the four siblings, no model spend at all:
 * nothing on the evidence plane calls a model, so a stand booted with a
 * dummy OPENAI_API_KEY scores the whole battery.
 *
 * Dimensions mirror memory-fitness's D1..D8 — one scorecard line each:
 *   E1 ingest & identity   E2 quarantine      E3 processing
 *   E4 fragments           E5 citations       E6 access
 *   E7 GC                  E8 GDPR
 */

export type Dimension = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8';

export const DIMENSION_LABELS: Record<Dimension, string> = {
  E1: 'ingest & identity',
  E2: 'quarantine',
  E3: 'processing',
  E4: 'fragments',
  E5: 'citations',
  E6: 'access',
  E7: 'gc',
  E8: 'gdpr',
};

export type CheckStatus = 'pass' | 'fail' | 'skipped';

/**
 * One check's identity, authored next to its assertion so the report and
 * the README can be generated from the same table.
 */
export interface CheckDef {
  /** Stable key (`e01-blob-upload`…) used in the scorecard and report. */
  id: string;
  dimension: Dimension;
  /** One line: what falsifying this check would mean. */
  intent: string;
  /**
   * Honest-baseline annotation (the domain-pack / code-memory
   * `expectedUnknown` pattern): the outcome depends on work that has not
   * landed. The runner still EXECUTES the check when its preconditions
   * exist; a fail is recorded as a finding and tallied separately
   * (`failedExpectedUnknown`), never forced green.
   */
  expectedUnknown?: string;
}

/** A check's verdict before the runner stamps timing onto it. */
export interface Verdict {
  status: CheckStatus;
  detail: string;
}

export const pass = (detail: string): Verdict => ({ status: 'pass', detail });
export const fail = (detail: string): Verdict => ({ status: 'fail', detail });
export const skip = (detail: string): Verdict => ({ status: 'skipped', detail });

export interface CheckResult extends CheckDef {
  status: CheckStatus;
  detail: string;
  latencyMs: number;
}

export interface Tally {
  pass: number;
  fail: number;
  skipped: number;
}

/**
 * Live capability state, read from the stand rather than assumed — the
 * `eval:code-memory` gate doctrine applied to the EVIDENCE_ family: a
 * check that cannot run because a knob is off, a route is absent or a
 * fixture could not be installed reports `skipped` with the observed
 * reason, never a silent pass.
 */
export interface Gates {
  /** GET /v1/admin/config, keyed by env name (`currentValue`). */
  config: Map<string, string>;
  /** Env names the config viewer declared `secret: true` (value masked). */
  secretKeys: Set<string>;
  /** Whether the orphan-blob GC maintenance route exists (probe status). */
  orphanGcRoute: { present: boolean; status: number };
  /** The run-scoped fixture pack, when its install succeeded. */
  packId: string | null;
  /** Install failure detail, for the skip reasons of dependent checks. */
  packError: string | null;
  /** The pack that declares a capability no adapter can serve. */
  denyPackId: string | null;
  /** Second tenant credentials, when the operator supplied them. */
  tenantB: { companyId: string; apiKey: string } | null;
}

/** One asset the battery minted: its id, its bytes and their identity. */
export interface MintedAsset {
  assetId: string;
  byteHash: string;
  bytes: Buffer;
  /** Server-minted content address, `fs://<tenant>/<hash>` for the fs adapter. */
  storageRef: string;
  availability: string;
  deduped: boolean;
  /** Citation target appended through the dedup path, when one was made. */
  fragmentId: string | null;
}

/** Everything the setup phases minted, threaded through the checks. */
export interface Stand {
  /** Primary blob-backed asset (owner user, document/text-plain). */
  primary: MintedAsset | null;
  /** Raw response of the primary upload — E2 reads its quarantine stamp. */
  primaryUploadStatus: number;
  primaryQuarantineStatus: string | null;
  /** A second asset, sacrificed by the destructive grant-revocation check. */
  spare: MintedAsset | null;
  /** Sole-owned by the forget subject — GDPR erasure must destroy it. */
  sole: MintedAsset | null;
  /** Co-owned by the forget subject and a survivor — must survive whole. */
  shared: MintedAsset | null;
  /** Tenant B's copy of the primary bytes (co-tenant survival check). */
  tenantB: MintedAsset | null;
  /** First dispatch counters — the idempotence check compares against them. */
  firstDispatch: Record<string, number> | null;
  /** A signed token minted early so the expiry check need not sleep a TTL. */
  agingToken: string | null;
  agingTokenExpiresAt: number;
  /** A token minted over the spare asset BEFORE its grants were revoked. */
  spareToken: string | null;
  /** POST /v1/users/:id/forget outcome, once phase 3 has run it. */
  forget: { status: number; json: unknown } | null;
}

export interface Scorecard {
  runId: string;
  baseUrl: string;
  companyId: string;
  ownerUserId: string;
  startedAt: string;
  finishedAt: string;
  /** Phase-0 trail: the live knob values and probes the gates came from. */
  setup: Record<string, string>;
  dimensions: Record<Dimension, Tally>;
  overall: Tally & { total: number; failedExpectedUnknown: number };
  /** Ids of gap-gated checks (expectedUnknown), pass or fail. */
  gapGatedChecks: string[];
  results: CheckResult[];
}
