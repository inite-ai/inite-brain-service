/**
 * Configuration modules — `code_memory__default_value`.
 *
 * Two modules ship here because a repository can state a default in two
 * very different registers, and they deserve different confidence:
 *
 *   CONFIG_CATALOG_MODULE (priority 80) reads a DECLARATIVE catalogue —
 *     this repo's `src/admin/config-catalog.data.ts`, the operator-facing
 *     source of truth for every env knob. A row there is a statement.
 *   DEFAULT_CONSTANTS_MODULE (priority 20) reads `DEFAULT_*` constants
 *     out of config-ish source files. Weaker evidence, so lower
 *     confidence — and it deliberately claims only files whose NAME says
 *     they hold configuration, never the whole tree.
 *
 * Both claim `config-catalog.data.ts`; the catalogue module wins on
 * priority (see `assignPaths`), which is the documented behaviour and is
 * asserted in the unit suite.
 *
 * THE VALUE-SHAPE FENCE. code_memory 0.4.3 fenced `default_value`
 * against prose after a battery finding: a behaviour fragment ("every
 * duration in milliseconds") is an invariant, never a default. Both
 * modules therefore refuse anything that is not a bare value token, and
 * the refusal is a client-side DROP with a reason — nothing prose-shaped
 * is ever sent for the server to reject.
 */
import type { RepoFact } from '../types';
import { moduleProducer, type EcosystemModule, type ModuleExtractInput } from './module.types';

/** Longest accepted default token — beyond this it is prose, not a value. */
const MAX_VALUE_CHARS = 64;

/**
 * Is `raw` value-shaped: a number, boolean, or single enum/identifier
 * token? Whitespace is the discriminator that does most of the work —
 * a default is one token, a sentence is not.
 */
export function isValueShaped(raw: string): boolean {
  const v = raw.trim();
  if (!v || v.length > MAX_VALUE_CHARS) return false;
  if (/\s/.test(v)) return false;
  // Sentence punctuation: a fragment, not a token.
  if (/[,;]/.test(v) || /\.$/.test(v)) return false;
  return /^[A-Za-z0-9_./:@^~+*-]+$/.test(v);
}

/** One parsed catalogue row. */
export interface CatalogDefault {
  key: string;
  value: string | null;
  line: number;
  excerpt: string;
}

/**
 * Pure: `{ key: 'X', …, defaultValue: 'Y', … }` rows out of a config
 * catalogue literal. A `null` default means "no default declared" and
 * yields no fact — an absent value is not a value.
 */
export function parseConfigCatalog(text: string): CatalogDefault[] {
  const rows: CatalogDefault[] = [];
  const lines = text.split('\n');
  let pendingKey: { key: string; line: number } | null = null;
  lines.forEach((line, i) => {
    const keyMatch = /^\s*key:\s*'([A-Za-z0-9_.]+)'\s*,/.exec(line);
    if (keyMatch?.[1]) {
      pendingKey = { key: keyMatch[1], line: i + 1 };
      return;
    }
    if (!pendingKey) return;
    const defMatch = /^\s*defaultValue:\s*(?:'([^']*)'|"([^"]*)"|(null))\s*,/.exec(line);
    if (defMatch) {
      const value = defMatch[3] === 'null' ? null : (defMatch[1] ?? defMatch[2] ?? '');
      rows.push({
        key: pendingKey.key,
        value,
        line: i + 1,
        excerpt: `key: '${pendingKey.key}',\n${line.trim()}`,
      });
      pendingKey = null;
      return;
    }
    // A new object literal before any defaultValue: the row declared none.
    if (/^\s*\},?\s*$/.test(line)) pendingKey = null;
  });
  return rows;
}

function catalogExtract(input: ModuleExtractInput): RepoFact[] {
  const producer = moduleProducer(CONFIG_CATALOG_MODULE);
  const facts: RepoFact[] = [];
  for (const path of input.paths) {
    const text = input.source.readFile(path);
    if (text === null) continue;
    for (const row of parseConfigCatalog(text)) {
      if (row.value === null || !isValueShaped(row.value)) continue;
      facts.push({
        producer,
        subject: row.key,
        subjectType: 'concept',
        kind: 'default_value',
        object: row.value,
        derivation:
          `Declared in the operator config catalogue ${path} line ${row.line} ` +
          `(defaultValue of the ${row.key} row). Read by ${producer}.`,
        evidence: { path, startLine: row.line, endLine: row.line, excerpt: row.excerpt },
        confidence: 0.9,
      });
    }
  }
  return facts;
}

const CATALOG_FILE = /(^|\/)config-catalog[\w.-]*\.(data\.)?ts$/;

export const CONFIG_CATALOG_MODULE: EcosystemModule = {
  id: 'config_catalog',
  version: '1.0.0',
  description: 'declarative operator config catalogues (config-catalog*.data.ts)',
  priority: 80,
  claims: (path) => CATALOG_FILE.test(path),
  extract: catalogExtract,
};

// ── DEFAULT_* constants ────────────────────────────────────────────────

/** Files whose NAME says they hold configuration. Never the whole tree. */
const CONFIG_ISH =
  /(^|[/\-.])(config|constants?|defaults?|flags|env)([\-.][\w.-]*)?\.(ts|js|mjs|cjs)$/;

export interface ConstantDefault {
  name: string;
  value: string;
  line: number;
  excerpt: string;
}

/**
 * Pure: `const DEFAULT_X = <literal>;` / `const X_DEFAULT = <literal>;`
 * declarations. Only literal initializers are read — an expression
 * (`process.env.X ?? 5`, a function call) has no single default to
 * quote, so it yields nothing.
 */
export function parseDefaultConstants(text: string): ConstantDefault[] {
  const out: ConstantDefault[] = [];
  text.split('\n').forEach((line, i) => {
    const m =
      /^\s*(?:export\s+)?const\s+(DEFAULT_[A-Z0-9_]+|[A-Z0-9_]+_DEFAULT)\s*(?::[^=]+)?=\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([\w.+-]+))\s*(?:as\s+const\s*)?;/.exec(
        line,
      );
    if (!m?.[1]) return;
    // Verbatim, always — a numeric separator (`512_000`) is part of how
    // the repository spells its own default, and rewriting it would make
    // the recorded value something no artefact actually says.
    const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
    out.push({ name: m[1], value, line: i + 1, excerpt: line.trim() });
  });
  return out;
}

function constantsExtract(input: ModuleExtractInput): RepoFact[] {
  const producer = moduleProducer(DEFAULT_CONSTANTS_MODULE);
  const facts: RepoFact[] = [];
  for (const path of input.paths) {
    const text = input.source.readFile(path);
    if (text === null) continue;
    for (const c of parseDefaultConstants(text)) {
      if (!isValueShaped(c.value)) continue;
      facts.push({
        producer,
        subject: c.name,
        subjectType: 'concept',
        kind: 'default_value',
        object: c.value,
        derivation:
          `Literal initializer of the ${c.name} constant at ${path} line ${c.line}. ` +
          `A constant is weaker evidence than a declared catalogue row. Read by ${producer}.`,
        evidence: { path, startLine: c.line, endLine: c.line, excerpt: c.excerpt },
        confidence: 0.7,
      });
    }
  }
  return facts;
}

export const DEFAULT_CONSTANTS_MODULE: EcosystemModule = {
  id: 'default_constants',
  version: '1.0.0',
  description: 'DEFAULT_* literal constants in config-named source files',
  priority: 20,
  claims: (path) => CONFIG_ISH.test(path),
  extract: constantsExtract,
};
