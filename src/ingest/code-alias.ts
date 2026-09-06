/**
 * Deterministic code-identifier alias derivation (INGEST_CODE_ALIAS_RESOLUTION).
 *
 * A module in a code-shaped corpus is routinely mentioned two ways: by its
 * FILE PATH ("src/gateway/webhook-dispatcher.ts") and by the SYMBOL it
 * defines ("WebhookDispatcher"). Both surfaces name the same real-world
 * thing, and the mapping between them is a filesystem-naming CONVENTION —
 * derivable byte-for-byte, no embeddings and no LLM. This module owns that
 * derivation; EntityUpsertService consumes it to reuse an existing entity
 * instead of minting a per-phrasing twin (the code-memory battery's k10
 * identity failure).
 *
 * Deliberately CONSERVATIVE — every helper returns null/false unless the
 * name is unambiguously code-shaped:
 *   - only source-code extensions derive a symbol (README.md, *.yml, *.json
 *     are docs/data — they define no symbol and must never alias onto an
 *     unrelated "Readme" entity);
 *   - the basename must contain a lowercase letter (README/LICENSE-style
 *     all-caps files are conventions, not modules) and must not be a
 *     super-generic module name (index.ts exists in every directory —
 *     deriving "Index" would fuse unrelated modules);
 *   - a derived or matched symbol must have >= 2 PascalCase humps: a single
 *     capitalized word ("Readme", "Priya", "Redis") reads as natural
 *     language, never as a code identifier.
 */

/** Source-code extensions whose file conventionally DEFINES a symbol. */
const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'cs',
  'swift',
  'scala',
  'php',
  'vue',
  'svelte',
  'dart',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
]);

/**
 * Basenames too generic to pin an identity: every package has an index/main/
 * utils, so the derived symbol would collide across unrelated modules.
 */
const GENERIC_BASENAMES = new Set([
  'index',
  'main',
  'mod',
  'init',
  'app',
  'lib',
  'setup',
  'types',
  'utils',
  'util',
  'helpers',
  'constants',
  'config',
  'common',
  'core',
  'shared',
  'base',
  'test',
  'tests',
  'spec',
]);

/** Path shape: optional dir segments, then `basename.ext`. No spaces. */
const CODE_PATH_RE = /^(?:[\w.@~-]+\/)*([A-Za-z][\w.-]*)\.([A-Za-z][A-Za-z0-9]*)$/;

/**
 * PascalCase code-symbol shape: >= 2 humps, letters/digits only, at least
 * one lowercase letter. "WebhookDispatcher" yes; "Readme" (one hump),
 * "webhookDispatcher" (camelCase), "WEBHOOK" (no lowercase) no.
 */
const PASCAL_SYMBOL_RE = /^[A-Z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/;

/**
 * Derive the conventional defined-symbol alias for a code file path:
 * basename without extension, kebab/snake/dot parts PascalCased —
 * "src/gateway/webhook-dispatcher.ts" → "WebhookDispatcher",
 * "entity-upsert.service.ts" → "EntityUpsertService". Returns null for
 * anything not clearly code-shaped (see the module header's bounds).
 */
export function symbolAliasForPath(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || /\s/.test(trimmed)) return null;
  const m = CODE_PATH_RE.exec(trimmed);
  if (!m) return null;
  const base = m[1]!;
  const ext = m[2]!.toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return null;
  if (!/[a-z]/.test(base)) return null; // README/LICENSE-style all-caps file
  if (GENERIC_BASENAMES.has(base.toLowerCase())) return null;
  const parts = base.split(/[-_.]+/).filter((p) => p.length > 0);
  if (parts.some((p) => !/^[A-Za-z][A-Za-z0-9]*$/.test(p))) return null;
  const symbol = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  // A single-hump result ("dispatcher.ts" → "Dispatcher") is a plain
  // capitalized word — too collision-prone to treat as an identity.
  return isCodeSymbolShaped(symbol) ? symbol : null;
}

/** Is this mention surface shaped like a PascalCase code symbol? */
export function isCodeSymbolShaped(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length <= 256 && PASCAL_SYMBOL_RE.test(trimmed) && /[a-z]/.test(trimmed);
}

/**
 * Lowercased basename spellings a PascalCase symbol conventionally maps to
 * ("WebhookDispatcher" → webhook-dispatcher / webhook_dispatcher /
 * webhookdispatcher) — substring NEEDLES for the reverse candidate scan.
 * Candidates found through a needle are then VERIFIED exactly by
 * re-deriving: symbolAliasForPath(candidate) === symbol. Mixed-separator
 * basenames a needle cannot reach (e.g. NestJS "entity-upsert.service.ts")
 * are a documented conservative miss — forward stamping covers them.
 */
export function pathNeedlesForSymbol(symbol: string): string[] {
  if (!isCodeSymbolShaped(symbol)) return [];
  const humps = symbol.trim().match(/[A-Z][a-z0-9]*/g) ?? [];
  if (humps.length < 2) return [];
  const lower = humps.map((h) => h.toLowerCase());
  return [...new Set([lower.join('-'), lower.join('_'), lower.join('')])];
}
