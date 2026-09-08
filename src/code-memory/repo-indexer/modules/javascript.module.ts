/**
 * JS/TS ecosystem module — `code_memory__depends_on_version`.
 *
 * Two artefacts, in precedence order: the pnpm lockfile (the EXACT
 * version actually installed) beats the package.json range (what was
 * asked for). Neither is inferred — both are quoted from the file, with
 * the line the value was read from.
 */
import type { RepoFact } from '../types';
import { moduleProducer, type EcosystemModule, type ModuleExtractInput } from './module.types';

const MANIFEST = /(^|\/)package\.json$/;
const LOCKFILE = /(^|\/)pnpm-lock\.yaml$/;

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface ManifestDep {
  name: string;
  spec: string;
  section: string;
}

/** Pure: declared dependencies of a package.json, in file order. */
export function parseManifestDeps(json: string): ManifestDep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  const deps: ManifestDep[] = [];
  for (const section of DEP_SECTIONS) {
    const block = root[section];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec === 'string' && spec.trim()) {
        deps.push({ name, spec: spec.trim(), section });
      }
    }
  }
  // `packageManager` and `engines.*` pin TOOLS the repo depends on — the
  // same claim class, a different spelling.
  const pm = root['packageManager'];
  if (typeof pm === 'string' && pm.includes('@')) {
    const at = pm.lastIndexOf('@');
    deps.push({ name: pm.slice(0, at), spec: pm.slice(at + 1), section: 'packageManager' });
  }
  const engines = root['engines'];
  if (typeof engines === 'object' && engines !== null) {
    for (const [name, spec] of Object.entries(engines as Record<string, unknown>)) {
      if (typeof spec === 'string' && spec.trim()) {
        deps.push({ name, spec: spec.trim(), section: 'engines' });
      }
    }
  }
  return deps;
}

/**
 * Pure: exact installed versions from a pnpm lockfile's `importers`
 * block (lockfileVersion 9 shape). Name lines sit at indent 6, their
 * `version:` at indent 8; the peer-suffix `(zod@4.5.4)` is a resolution
 * detail, not the version, so it is trimmed.
 *
 * A line-oriented reader rather than a YAML parse: the shape is fixed
 * and machine-written, and pulling a YAML dependency into an operator
 * tool is supply-chain surface this does not need. Anything the reader
 * does not recognize is simply absent — the package.json range is then
 * the recorded value, never a guess.
 */
export function parseLockfileVersions(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = yaml.split('\n');
  let inImporters = false;
  let current: string | null = null;
  for (const line of lines) {
    if (/^[A-Za-z]/.test(line)) {
      inImporters = line.startsWith('importers:');
      current = null;
      continue;
    }
    if (!inImporters) continue;
    const nameMatch = /^ {6}(['"]?)([^'":]+)\1:\s*$/.exec(line);
    if (nameMatch) {
      current = nameMatch[2] ?? null;
      continue;
    }
    const versionMatch = /^ {8}version:\s*(.+)$/.exec(line);
    if (versionMatch && current) {
      const raw = (versionMatch[1] ?? '').trim();
      const version = raw.split('(')[0]?.trim() ?? '';
      // First writer wins: the root importer is emitted before workspace
      // packages, so the root's resolution is the one recorded.
      if (version && !out.has(current)) out.set(current, version);
      current = null;
    }
  }
  return out;
}

/** 1-based line of the first `"<key>":` occurrence, or 0. */
function lineOfKey(text: string, key: string): number {
  const needle = `"${key}":`;
  const idx = text.indexOf(needle);
  if (idx === -1) return 0;
  return text.slice(0, idx).split('\n').length;
}

function lineText(text: string, line: number): string {
  return line > 0 ? (text.split('\n')[line - 1] ?? '').trim() : '';
}

function extract(input: ModuleExtractInput): RepoFact[] {
  const { paths, source } = input;
  const producer = moduleProducer(JAVASCRIPT_MODULE);
  const lockPath = paths.find((p) => LOCKFILE.test(p));
  const lockText = lockPath ? source.readFile(lockPath) : null;
  const resolved = lockText ? parseLockfileVersions(lockText) : new Map<string, string>();

  const facts: RepoFact[] = [];
  for (const manifestPath of paths.filter((p) => MANIFEST.test(p))) {
    const text = source.readFile(manifestPath);
    if (text === null) continue;
    for (const dep of parseManifestDeps(text)) {
      const manifestLine = lineOfKey(text, dep.name);
      const exact = resolved.get(dep.name);
      facts.push(
        exact !== undefined && lockPath !== undefined
          ? {
              producer,
              subject: dep.name,
              subjectType: 'concept',
              kind: 'depends_on_version',
              object: exact,
              derivation:
                `Exact installed version read from ${lockPath} (pnpm importers block) for the ` +
                `${dep.section} range "${dep.spec}" declared in ${manifestPath}. Read by ${producer}.`,
              evidence: {
                path: lockPath,
                startLine: 0,
                endLine: 0,
                excerpt: `${dep.name}:\n  specifier: ${dep.spec}\n  version: ${exact}`,
              },
              confidence: 0.95,
            }
          : {
              producer,
              subject: dep.name,
              subjectType: 'concept',
              kind: 'depends_on_version',
              object: dep.spec,
              derivation:
                `Declared range in ${manifestPath} (${dep.section}); no lockfile resolution was ` +
                `available, so the declared range is recorded verbatim rather than an exact ` +
                `version. Read by ${producer}.`,
              evidence: {
                path: manifestPath,
                startLine: manifestLine,
                endLine: manifestLine,
                excerpt: lineText(text, manifestLine) || `"${dep.name}": "${dep.spec}"`,
              },
              confidence: 0.85,
            },
      );
    }
  }
  return facts;
}

export const JAVASCRIPT_MODULE: EcosystemModule = {
  id: 'javascript',
  version: '1.0.0',
  description: 'npm/pnpm dependency pins from package.json and pnpm-lock.yaml',
  priority: 60,
  claims: (path) => MANIFEST.test(path) || LOCKFILE.test(path),
  extract,
};
