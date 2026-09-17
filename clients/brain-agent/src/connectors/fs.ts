import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path';
import type { AgentConnector, ConnectorCtx, EnumerateOptions, FetchedItem, ItemDelta, ItemDescriptor, Modality } from '../types.js';
import { DEFAULT_IGNORE_FILES, PathFilter } from './path-rules.js';

/**
 * `fs` on the agent host — a folder on THIS machine: the laptop's notes,
 * an Obsidian vault, a Downloads folder, a share the OS already mounts.
 * **Duplicate** of the walking rules in the brain's
 * src/source-plane/connectors/fs.connector.ts (+ media.ts): hidden
 * entries and VCS/build directories skipped, symlinks never followed,
 * text extensions as documents, binary ones to the evidence door under
 * their modality, `mtime:size` as the revision, caps on files and bytes.
 * The root is whatever the operator set on the connection — this host
 * is the user's own machine, so there is no server-side jail to fit; an
 * optional BRAIN_AGENT_ROOTS allowlist fences it when the agent runs
 * for others (a CI box, a shared server).
 */
export interface FsConfig {
  root: string;
  extensions?: string[];
  excludeDirs?: string[];
  includeHidden?: boolean;
  /** Only paths matching one of these (gitignore-style globs relative to root); empty = everything. */
  include?: string[];
  /** Paths (files or directories) matching one of these are skipped. */
  exclude?: string[];
  /** gitignore-style files honoured in the tree (default `.brainignore`). */
  ignoreFiles?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export const TEXT_EXTENSIONS = [
  'md', 'markdown', 'txt', 'text', 'rst', 'adoc', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'html', 'htm', 'xml', 'log',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'sql', 'graphql', 'proto',
];
export const BINARY_MODALITIES: Record<string, Modality> = {
  pdf: 'document', docx: 'document', xlsx: 'document', pptx: 'document', eml: 'document',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
};
export const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', text: 'text/plain',
  rst: 'text/plain', adoc: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain',
  ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain', html: 'text/html', htm: 'text/html',
  xml: 'text/xml', log: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
};
const DEFAULT_EXCLUDE_DIRS = [
  '.git', 'node_modules', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__',
  '.cache', '.next', '.idea', '.vscode', 'coverage',
];
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;

export class FsAgentConnector implements AgentConnector {
  readonly kind = 'fs';
  readonly walksEverything = true;

  constructor(private readonly allowedRoots: string[] = []) {}

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const root = await this.jailedRoot(cfg.root);
    const extensions = new Set(extensionsFor(ctx, cfg));
    const exclude = new Set(cfg.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
    const maxFiles = Math.max(1, cfg.maxFiles ?? DEFAULT_MAX_FILES);
    const maxBytes = fileByteCap(cfg);
    const filter = new PathFilter({ include: cfg.include, exclude: cfg.exclude });
    const ignoreFiles = cfg.ignoreFiles ?? DEFAULT_IGNORE_FILES;
    let emitted = 0;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const rel = toPosix(relative(root, dir));
      // The directory's own ignore files apply to its entries: read first.
      const entries = await readdir(dir, { withFileTypes: true });
      for (const name of ignoreFiles) {
        if (entries.some((e) => e.name === name && e.isFile())) {
          filter.addIgnoreFile(rel, await readFile(join(dir, name), 'utf8'));
        }
      }
      for (const entry of entries) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (!cfg.includeHidden && entry.name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!exclude.has(entry.name) && filter.admitsDir(relPath)) stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = extOf(entry.name);
        if (!extensions.has(ext)) continue;
        if (!filter.admitsFile(relPath)) continue;
        const st = await lstat(full);
        if (st.size > maxBytes) continue;
        if (++emitted > maxFiles) {
          ctx.log(`fs: maxFiles ${maxFiles} reached under ${root} — walk truncated`);
          yield { type: 'checkpoint', checkpoint: { walkedAt: new Date().toISOString(), files: emitted - 1, truncated: true } };
          return;
        }
        const externalId = toPosix(relative(root, full));
        yield {
          type: 'upsert',
          item: {
            externalId,
            path: externalId,
            title: entry.name,
            originUri: `file://${full}`,
            mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
            size: st.size,
            revision: `${Math.trunc(st.mtimeMs)}:${st.size}`,
            modifiedAt: st.mtime.toISOString(),
          },
        };
      }
    }
    yield { type: 'checkpoint', checkpoint: { walkedAt: new Date().toISOString(), files: emitted } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const root = await this.jailedRoot(cfg.root);
    const full = containedPath(root, item.externalId);
    const st = await lstat(full);
    if (!st.isFile()) throw new Error(`not a regular file: ${item.externalId}`);
    if (st.size > fileByteCap(cfg)) throw new Error(`file over maxFileBytes: ${item.externalId}`);
    const ext = extOf(basename(full));
    const bytes = await readFile(full);
    if (ctx.connection.shape === 'binary') {
      return {
        shape: 'binary',
        bytesBase64: bytes.toString('base64'),
        mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
        modality: BINARY_MODALITIES[ext] ?? 'image',
        occurredAt: st.mtime.toISOString(),
      };
    }
    if (looksBinary(bytes)) throw new Error(`binary content in a text-shaped item: ${item.externalId}`);
    return { shape: 'document', text: bytes.toString('utf8'), title: basename(full), occurredAt: st.mtime.toISOString(), kind: 'file' };
  }

  private async jailedRoot(configRoot: string): Promise<string> {
    const root = resolve(configRoot);
    if (this.allowedRoots.length > 0 && !this.allowedRoots.some((r) => root === resolve(r) || root.startsWith(`${resolve(r)}${sep}`))) {
      throw new Error(`fs: root ${root} is outside BRAIN_AGENT_ROOTS`);
    }
    const st = await lstat(root);
    if (!st.isDirectory()) throw new Error(`fs: root ${root} is not a directory`);
    return root;
  }
}

export function containedPath(root: string, externalId: string): string {
  const full = resolve(root, externalId);
  if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error(`fs: item escapes the root: ${externalId}`);
  return full;
}

export function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192);
  return head.includes(0);
}

function configOf(ctx: ConnectorCtx): FsConfig {
  const cfg = ctx.connection.config as Partial<FsConfig>;
  if (typeof cfg.root !== 'string' || cfg.root.length === 0) throw new Error('fs: config.root is required');
  return cfg as FsConfig;
}

function extensionsFor(ctx: ConnectorCtx, cfg: FsConfig): string[] {
  const declared = cfg.extensions?.map((e) => e.toLowerCase().replace(/^\./, ''));
  if (declared && declared.length > 0) return declared;
  return ctx.connection.shape === 'binary' ? Object.keys(BINARY_MODALITIES) : TEXT_EXTENSIONS;
}

function fileByteCap(cfg: FsConfig): number {
  return Math.min(Math.max(1, cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES), HARD_MAX_FILE_BYTES);
}

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}
