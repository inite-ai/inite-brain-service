/**
 * The two boolean env readers, in a module that imports nothing: every
 * `*-flags.ts` file uses them, and env-validation.ts both re-exports them
 * and calls into some of those files, so keeping them here is what keeps
 * the graph acyclic.
 */

/**
 * Parse a boolean env flag accepting BOTH house idioms ('1' and 'true',
 * case-insensitive). The repo historically mixed `=== '1'` and
 * `=== 'true'` per file; for security-relevant flags that split is a
 * fail-open trap (`DOMAIN_PACK_REQUIRE_SIGNATURE=1` silently parsed as
 * false by a 'true'-only check). Values outside FLAG_VALUES are rejected
 * at boot by validatePackTrustEnv for the pack-trust flags.
 */
export function envFlagEnabled(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Default-ON flags: enabled unless explicitly set to 0/false. Use for
 * per-tenant kill-switches on genre-dependent behavior; measured-winner
 * defaults fold into the code instead of keeping a flag.
 */
export function envFlagNotDisabled(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}
