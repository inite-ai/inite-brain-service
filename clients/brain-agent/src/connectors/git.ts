import { execFile } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentConnector, ConnectorCtx, EnumerateOptions, FetchedItem, ItemDelta, ItemDescriptor } from '../types.js';
import { compileRule } from './path-rules.js';

const run = promisify(execFile);

/**
 * `git` — the repository's DOCS as documents, read from the committed
 * tree: READMEs, docs/**, ADRs, changelogs — whatever text files the
 * connection's extensions admit — each with its blob sha as the
 * revision (content-addressed: the same text under two commits is one
 * revision; a one-line edit is a new one) and the commit that last
 * touched it as the time it occurred. Structure — decisions, ownership,
 * pins — stays with the repo indexer (`pnpm indexer:repo`); one repo,
 * two shapes. git runs HERE, on the agent, never in the brain process
 * (the "no git lives here" rule of the roadmap). Every invocation is an
 * argv array — no shell, no interpolation.
 */
export interface GitConfig {
  repo: string;
  /** Default HEAD. */
  ref?: string;
  /** Default: the docs extensions. */
  extensions?: string[];
  /**
   * Keep only paths matching one of these: a prefix ('docs/', 'README')
   * or a glob ('docs/**', '*.md', 'adr/????-*.md').
   */
  include?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export const DOC_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'adoc'];
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export class GitAgentConnector implements AgentConnector {
  readonly kind = 'git';
  readonly walksEverything = true;

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const repo = resolve(cfg.repo);
    const ref = cfg.ref ?? 'HEAD';
    const commit = (await git(repo, ['rev-parse', ref])).trim();
    const origin = await originOf(repo);
    const extensions = new Set((cfg.extensions ?? DOC_EXTENSIONS).map((e) => e.toLowerCase().replace(/^\./, '')));
    const maxFiles = Math.max(1, cfg.maxFiles ?? DEFAULT_MAX_FILES);
    const maxBytes = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const include = (cfg.include ?? []).map(includeMatcher);
    const listing = await git(repo, ['ls-tree', '-r', '-z', '--long', commit]);
    let emitted = 0;
    for (const line of listing.split('\0')) {
      if (!line) continue;
      if (ctx.signal.aborted) throw new Error('aborted');
      // "<mode> <type> <sha> <size>\t<path>"
      const tab = line.indexOf('\t');
      const [, type, sha, sizeRaw] = line.slice(0, tab).split(/\s+/);
      const path = line.slice(tab + 1);
      if (type !== 'blob' || !sha) continue;
      if (!extensions.has(extname(path).slice(1).toLowerCase())) continue;
      if (include.length > 0 && !include.some((m) => m(path))) continue;
      const size = Number(sizeRaw);
      if (Number.isFinite(size) && size > maxBytes) continue;
      if (++emitted > maxFiles) {
        ctx.log(`git: maxFiles ${maxFiles} reached in ${repo} — walk truncated`);
        yield { type: 'checkpoint', checkpoint: { commit, walkedAt: new Date().toISOString(), files: emitted - 1, truncated: true } };
        return;
      }
      yield {
        type: 'upsert',
        item: {
          externalId: path,
          path,
          title: basename(path),
          originUri: `${origin}#${path}`,
          mediaType: path.endsWith('.md') || path.endsWith('.markdown') ? 'text/markdown' : 'text/plain',
          ...(Number.isFinite(size) ? { size } : {}),
          revision: sha,
        },
      };
    }
    yield { type: 'checkpoint', checkpoint: { commit, walkedAt: new Date().toISOString(), files: emitted } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const repo = resolve(cfg.repo);
    if (!item.revision || !/^[0-9a-f]{40,64}$/.test(item.revision)) {
      throw new Error(`git: item ${item.externalId} carries no blob sha`);
    }
    if (ctx.connection.shape !== 'document') throw new Error('git: only the document shape is supported');
    // Content-addressed: the blob the catalogue named, whatever HEAD is now.
    const text = await git(repo, ['cat-file', '-p', item.revision]);
    if (text.includes('\0')) throw new Error(`git: binary blob in a text item: ${item.externalId}`);
    const when = (await git(repo, ['log', '-1', '--format=%cI', cfg.ref ?? 'HEAD', '--', item.externalId])).trim();
    return {
      shape: 'document',
      text,
      title: basename(item.externalId),
      ...(when ? { occurredAt: new Date(when).toISOString() } : {}),
      kind: 'repo_doc',
    };
  }
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The origin remote without credentials, else the repo path — the origin prefix of every item. */
async function originOf(repo: string): Promise<string> {
  try {
    const raw = (await git(repo, ['remote', 'get-url', 'origin'])).trim();
    return normaliseRemote(raw);
  } catch {
    return `file://${repo}`;
  }
}

export function normaliseRemote(raw: string): string {
  const ssh = /^(?:[\w.-]+@)?([\w.-]+):([\w./-]+?)(?:\.git)?$/.exec(raw);
  if (ssh && !raw.includes('://')) return `git://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return `${u.protocol}//${u.host}${u.pathname.replace(/\.git$/, '')}`;
  } catch {
    return raw;
  }
}

function configOf(ctx: ConnectorCtx): GitConfig {
  const cfg = ctx.connection.config as Partial<GitConfig>;
  if (typeof cfg.repo !== 'string' || cfg.repo.length === 0) throw new Error('git: config.repo is required');
  return cfg as GitConfig;
}

/** A prefix (`docs/`, `README`) or a gitignore-style glob (`docs/**`, `*.md`, `adr/????-*.md`) → predicate on a repo path. */
export function includeMatcher(pattern: string): (path: string) => boolean {
  if (!/[*?]/.test(pattern)) return (path) => path.startsWith(pattern);
  const rule = compileRule(pattern);
  if (!rule) return () => false;
  return (path) => rule.re.test(rule.byName ? path.slice(path.lastIndexOf('/') + 1) : path);
}
