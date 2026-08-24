/**
 * Declarative CLI flags for eval runners — replaces the hand-rolled
 * if/else chains that were copy-pasted between axis scripts. Unknown
 * `--flags` throw: a typo in a paid run should fail at parse time, not
 * silently run with defaults.
 */

export type FlagType = 'string' | 'int' | 'bool' | 'list';

export interface FlagSpec {
  /** Destination key on the args object. */
  key: string;
  type: FlagType;
}

export function parseFlags<T extends Record<string, unknown>>(
  argv: string[],
  spec: Record<string, FlagSpec>,
  defaults: T,
): T {
  const args = { ...defaults } as Record<string, unknown>;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const def = spec[flag];
    if (!def) throw new Error(`unknown flag ${flag}`);
    if (def.type === 'bool') {
      args[def.key] = true;
      continue;
    }
    const raw = argv[++i];
    if (raw === undefined) throw new Error(`flag ${flag} needs a value`);
    if (def.type === 'int') {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) throw new Error(`flag ${flag} needs an integer`);
      args[def.key] = n;
    } else if (def.type === 'list') {
      args[def.key] = raw.split(',');
    } else {
      args[def.key] = raw;
    }
  }
  return args as T;
}
