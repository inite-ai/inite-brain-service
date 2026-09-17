import { readdir } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';

/**
 * What this machine can offer — the folders under the agent's roots
 * (or the home directory when no roots fence it), a few levels deep,
 * bounded, hidden and build directories left out. Reported to the brain
 * on every pass so the admin's folder picker can browse a laptop the
 * brain will never see itself. Directory NAMES only, never contents.
 */
export interface Inventory {
  version: string;
  hostname: string;
  platform: string;
  roots: Array<{ path: string; folders: string[] }>;
}

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.cache', '.next', 'dist', 'build', 'target', 'Library', 'Applications']);
const MAX_FOLDERS = 2000;

export async function inventory(roots: string[], version: string): Promise<Inventory> {
  const bases = roots.length > 0 ? roots.map((r) => resolve(r)) : [homedir()];
  const depth = roots.length > 0 ? 3 : 2;
  return {
    version,
    hostname: hostname().split('.')[0] ?? 'unknown',
    platform: platform(),
    roots: await Promise.all(bases.map(async (path) => ({ path, folders: await foldersUnder(path, depth) }))),
  };
}

export async function foldersUnder(root: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  const stack: Array<[string, number]> = [[root, 0]];
  while (stack.length > 0 && out.length < MAX_FOLDERS) {
    const [dir, level] = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      out.push(toPosix(relative(root, full)));
      if (level + 1 < depth) stack.push([full, level + 1]);
      if (out.length >= MAX_FOLDERS) break;
    }
  }
  return out.sort();
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join(posix.sep);
}
