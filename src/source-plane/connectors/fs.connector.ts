import { Injectable } from '@nestjs/common';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path';
import { sourceFsRoots, sourceKindEnabled } from '../../common/source-plane-flags';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';

/**
 * `fs` — the first native (raw-evidence-sources-2026-09.md W1): a
 * directory on the brain host's own filesystem — a mounted volume, a
 * network share mounted by the OS, or the laptop a fully-local brain
 * runs on. No change feed exists for a directory, so every run is a
 * full walk (`walksEverything`) and the engine marks what the walk did
 * not see gone: polling by mtime + size, hashing only what the store
 * already hashes on write.
 *
 * SECURITY, in order of importance:
 *   1. Root jail — `config.root` must resolve (realpath) inside one of
 *      SOURCE_FS_ROOTS; unset ⇒ no root is permitted. Brain's process
 *      reading arbitrary host paths is a capability an operator grants
 *      by name.
 *   2. Symlinks are never followed (lstat; a symlink is skipped), so a
 *      link out of the jail cannot pull foreign files in.
 *   3. `externalId` is the POSIX-relative path; fetch re-joins it under
 *      the root and re-checks containment, so a crafted catalogue row
 *      cannot read outside.
 *   4. Bounded: `maxFiles` per walk, `maxFileBytes` per file, hidden
 *      entries and the usual build/VCS directories excluded by default.
 *
 * Shape: the connection's declared shape decides which files are items —
 * `document` ⇒ text-like extensions read as UTF-8 (a file with NUL bytes
 * is skipped as binary), `binary` ⇒ PDFs and images handed to the
 * evidence door with their media type. Same connector, two entries in
 * the pack (file_memory: `folder` / `folder_media`).
 */

export interface FsConnectorConfig {
  root: string;
  /** Lower-case, no dot. Defaults per shape (below). */
  extensions?: string[] | undefined;
  /** Directory NAMES skipped anywhere in the tree. */
  excludeDirs?: string[] | undefined;
  /** Hidden entries (leading dot) are skipped unless this is true. */
  includeHidden?: boolean | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
}

export const FS_TEXT_EXTENSIONS = [
  'md',
  'markdown',
  'txt',
  'text',
  'rst',
  'adoc',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'html',
  'htm',
  'xml',
  'log',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'sh',
  'sql',
  'graphql',
  'proto',
];

export const FS_BINARY_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'];

const DEFAULT_EXCLUDE_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  '.idea',
  '.vscode',
  'coverage',
];
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  rst: 'text/plain',
  adoc: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'text/plain',
  yml: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  log: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

@Injectable()
export class FsConnector implements Connector {
  readonly kind = 'fs';
  readonly walksEverything = true;

  enabled(): boolean {
    return sourceKindEnabled('fs');
  }

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const root = await jailedRoot(cfg.root);
    const walk: WalkOptions = {
      root,
      exclude: new Set((cfg.excludeDirs ?? DEFAULT_EXCLUDE_DIRS).map((d) => d.toLowerCase())),
      extensions: new Set(extensionsFor(ctx, cfg)),
      includeHidden: cfg.includeHidden === true,
      maxBytes: fileByteCap(cfg),
      signal: ctx.signal,
    };
    const maxFiles = cfg.maxFiles ?? DEFAULT_MAX_FILES;
    const tally = { emitted: 0, skippedLarge: 0 };
    for await (const item of walkFiles(walk, tally)) {
      yield { type: 'upsert', item };
      if (tally.emitted >= maxFiles) {
        ctx.log(`fs walk of ${root} hit maxFiles=${maxFiles}; the rest waits for the next run`);
        break;
      }
    }
    if (tally.skippedLarge > 0) {
      ctx.log(`fs walk of ${root} skipped ${tally.skippedLarge} file(s) over maxFileBytes`);
    }
    yield {
      type: 'checkpoint',
      checkpoint: { walkedAt: new Date().toISOString(), files: tally.emitted },
    };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const root = await jailedRoot(cfg.root);
    const full = containedPath(root, item.externalId);
    const st = await lstat(full);
    if (!st.isFile()) throw new Error(`not a regular file: ${item.externalId}`);
    if (st.size > fileByteCap(cfg)) throw new Error(`file over maxFileBytes: ${item.externalId}`);
    const ext = extOf(basename(full));
    const mediaType = MEDIA_TYPES[ext] ?? 'application/octet-stream';
    if (ctx.connection.shape === 'binary') {
      const bytes = await readFile(full);
      return {
        shape: 'binary',
        bytes,
        mediaType,
        modality: ext === 'pdf' ? 'document' : 'image',
        occurredAt: st.mtime.toISOString(),
      };
    }
    const bytes = await readFile(full);
    if (looksBinary(bytes))
      throw new Error(`binary content in a text-shaped item: ${item.externalId}`);
    return {
      shape: 'document',
      text: bytes.toString('utf8'),
      title: basename(full),
      occurredAt: st.mtime.toISOString(),
      kind: 'file',
    };
  }
}

interface WalkOptions {
  root: string;
  exclude: Set<string>;
  extensions: Set<string>;
  includeHidden: boolean;
  maxBytes: number;
  signal: AbortSignal;
}

/**
 * Depth-first walk yielding one descriptor per admitted regular file.
 * Directory entries are read with `opendir`; a symlink of any kind is
 * skipped before it is ever stat'ed through, an excluded or hidden
 * directory is never descended, an oversized file is counted and
 * skipped. `tally` is the caller's — the generator has no return channel
 * the engine reads.
 */
async function* walkFiles(
  w: WalkOptions,
  tally: { emitted: number; skippedLarge: number },
): AsyncIterable<ItemDescriptor> {
  const stack: string[] = [w.root];
  while (stack.length > 0) {
    if (w.signal.aborted) throw new Error('aborted');
    const dir = stack.pop()!;
    for await (const entry of await opendir(dir)) {
      const admitted = admitEntry(w, entry);
      if (admitted === 'descend') {
        stack.push(join(dir, entry.name));
        continue;
      }
      if (admitted !== 'file') continue;
      const full = join(dir, entry.name);
      const st = await lstat(full);
      if (!st.isFile()) continue;
      if (st.size > w.maxBytes) {
        tally.skippedLarge++;
        continue;
      }
      tally.emitted++;
      yield describeFile(w.root, full, st);
    }
  }
}

function admitEntry(
  w: WalkOptions,
  entry: { name: string; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean },
): 'descend' | 'file' | 'skip' {
  const { name } = entry;
  if (!w.includeHidden && name.startsWith('.')) return 'skip';
  if (entry.isSymbolicLink()) return 'skip';
  if (entry.isDirectory()) return w.exclude.has(name.toLowerCase()) ? 'skip' : 'descend';
  if (!entry.isFile()) return 'skip';
  return w.extensions.has(extOf(name)) ? 'file' : 'skip';
}

function describeFile(
  root: string,
  full: string,
  st: { size: number; mtimeMs: number; mtime: Date },
): ItemDescriptor {
  const name = basename(full);
  const ext = extOf(name);
  const externalId = toPosix(relative(root, full));
  return {
    externalId,
    path: externalId,
    title: name,
    originUri: `file://${full}`,
    mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
    size: st.size,
    revision: `${Math.trunc(st.mtimeMs)}:${st.size}`,
    modifiedAt: st.mtime.toISOString(),
  };
}

function configOf(ctx: ConnectorCtx): FsConnectorConfig {
  const cfg = ctx.connection.config as Partial<FsConnectorConfig>;
  if (typeof cfg.root !== 'string' || cfg.root.length === 0) {
    throw new Error('fs connector: config.root is required');
  }
  return cfg as FsConnectorConfig;
}

function extensionsFor(ctx: ConnectorCtx, cfg: FsConnectorConfig): string[] {
  const declared = cfg.extensions?.map((e) => e.toLowerCase().replace(/^\./, ''));
  if (declared && declared.length > 0) return declared;
  return ctx.connection.shape === 'binary' ? FS_BINARY_EXTENSIONS : FS_TEXT_EXTENSIONS;
}

function fileByteCap(cfg: FsConnectorConfig): number {
  const v = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return Math.min(Math.max(1, v), HARD_MAX_FILE_BYTES);
}

/**
 * Resolve the connection root and prove it sits inside one of the
 * operator's SOURCE_FS_ROOTS (realpath on both sides, so neither a
 * symlinked root nor a `..` segment escapes). Fail closed on an empty
 * allowlist.
 */
export async function jailedRoot(configRoot: string): Promise<string> {
  const roots = sourceFsRoots();
  if (roots.length === 0) {
    throw new Error('fs connector: SOURCE_FS_ROOTS is not set — no directory is permitted');
  }
  let real: string;
  try {
    real = await realpath(resolve(configRoot));
  } catch {
    throw new Error(`fs connector: root does not exist: ${configRoot}`);
  }
  for (const allowed of roots) {
    let allowedReal: string;
    try {
      allowedReal = await realpath(resolve(allowed));
    } catch {
      continue;
    }
    if (real === allowedReal || real.startsWith(allowedReal + sep)) return real;
  }
  throw new Error(`fs connector: root ${configRoot} is outside SOURCE_FS_ROOTS`);
}

/** Re-join a catalogue path under the root and refuse anything that leaves it. */
export function containedPath(root: string, externalId: string): string {
  if (externalId.includes('\0')) throw new Error('fs connector: invalid path');
  const full = resolve(root, ...externalId.split('/'));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`fs connector: path escapes the root: ${externalId}`);
  }
  return full;
}

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join(posix.sep);
}

/** A NUL byte in the first 8 KiB is a binary file, whatever its extension. */
export function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192);
  return head.includes(0);
}
