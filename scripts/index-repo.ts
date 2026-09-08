#!/usr/bin/env ts-node
/**
 * Reference code-repository indexer for the `code_memory` domain pack.
 *
 * OPERATOR / CI INVOKED ONLY — nothing schedules this, no Nest module
 * imports it, and it makes no network call at all until `--submit` is
 * passed. Placement follows `scripts/capture-decisions.ts`: the CLI is a
 * thin shell over pure modules under `src/code-memory/repo-indexer/`, so
 * the derivation rules are unit-tested without a process, a git binary,
 * or a server.
 *
 *   # see what this repository would contribute — no network, no key
 *   pnpm indexer:repo -- --repo . --dry-run
 *
 *   # submit for real (key needs brain:write + indexer:write, and if it
 *   # is pack-bound it must be bound to code_memory)
 *   BRAIN_API_KEY=... pnpm indexer:repo -- \
 *     --repo . --brain-url https://brain.inite.ai --submit
 *
 *   # second run: only the delta since the last recorded HEAD
 *   BRAIN_API_KEY=... pnpm indexer:repo -- --repo . --since auto --submit
 *
 * Flags:
 *   --repo <path>        repository root (default: cwd)
 *   --brain-url <url>    Brain base URL (default: $BRAIN_URL)
 *   --pack <id>          pack id (default: code_memory)
 *   --vertical <name>    contextRef.vertical for the evidence documents
 *   --since <commit|auto> incremental lower bound; `auto` = state file HEAD
 *   --modules <a,b>      restrict the ecosystem-module registry
 *   --state <path>       state file (default: <repo>/.brain-indexer-state.json)
 *   --max-candidates <n> per-run cap (default 500)
 *   --max-files <n>      working-tree file cap (default 5000)
 *   --submit             actually POST; omitted = dry run
 *   --json               machine-readable summary on stdout
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_CAPS, type IndexerCaps } from '../src/code-memory/repo-indexer/types';
import { FsRepoSource } from '../src/code-memory/repo-indexer/repo-source';
import { selectModules } from '../src/code-memory/repo-indexer/modules/registry';
import {
  HttpBrainClient,
  type BrainClient,
} from '../src/code-memory/repo-indexer/brain-client';
import { DryRunBrainClient } from '../src/code-memory/repo-indexer/dry-run-client';
import { EMPTY_STATE, runIndexer, type RunState } from '../src/code-memory/repo-indexer/run';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i !== -1 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name);
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readState(path: string): RunState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunState>;
    return {
      lastCommit: typeof parsed.lastCommit === 'string' ? parsed.lastCommit : null,
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
      submitted: Array.isArray(parsed.submitted)
        ? parsed.submitted.filter((s): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function buildClient(packId: string, vertical: string): BrainClient {
  if (!flag('submit')) return new DryRunBrainClient();
  const baseUrl = arg('brain-url') ?? process.env.BRAIN_URL;
  const apiKey = process.env.BRAIN_API_KEY;
  if (!baseUrl) throw new Error('--brain-url (or BRAIN_URL) is required with --submit');
  if (!apiKey) {
    throw new Error('BRAIN_API_KEY is required with --submit (scopes: brain:write, indexer:write)');
  }
  return new HttpBrainClient({ baseUrl, apiKey, vertical, packId });
}

async function main(): Promise<void> {
  const root = resolve(arg('repo') ?? process.cwd());
  const packId = arg('pack') ?? 'code_memory';
  const vertical = arg('vertical') ?? 'engineering';
  const statePath = arg('state') ?? join(root, '.brain-indexer-state.json');
  const state = readState(statePath);

  const caps: IndexerCaps = {
    ...DEFAULT_CAPS,
    maxCandidates: intArg('max-candidates', DEFAULT_CAPS.maxCandidates),
    maxFiles: intArg('max-files', DEFAULT_CAPS.maxFiles),
  };

  const sinceRaw = arg('since');
  const since = sinceRaw === 'auto' ? (state.lastCommit ?? undefined) : (sinceRaw ?? undefined);
  if (sinceRaw === 'auto' && !since) {
    console.error('[indexer] --since auto: no recorded HEAD yet, running a full walk');
  }

  const modules = selectModules(
    arg('modules')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const client = buildClient(packId, vertical);

  const summary = await runIndexer({
    source: new FsRepoSource({ root, maxFiles: caps.maxFiles, maxFileBytes: caps.maxFileBytes }),
    client,
    caps,
    packId,
    repoLabel: basename(root),
    modules,
    state,
    since,
    log: (line) => console.error(`[indexer] ${line}`),
  });

  if (flag('json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error(
      `[indexer] head=${summary.headSha?.slice(0, 12) ?? 'none'} ` +
        `incremental=${summary.incremental} files=${summary.filesScanned} ` +
        `commits=${summary.commitsRead} derived=${summary.derived} ` +
        `submitted=${summary.submitted} dropped=${summary.dropped.length} ` +
        `documents=${summary.documents}`,
    );
    for (const [producer, count] of Object.entries(summary.byProducer).sort()) {
      console.error(`[indexer]   ${producer}: ${count}`);
    }
    const reasons = new Map<string, number>();
    for (const d of summary.dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
    for (const [reason, count] of [...reasons.entries()].sort()) {
      console.error(`[indexer]   dropped ${reason}: ${count}`);
    }
  }

  if (client instanceof DryRunBrainClient) {
    console.error(
      `[indexer] DRY RUN — nothing was sent. ${client.documents.length} evidence document(s) ` +
        `would carry ${client.submissions.reduce((n, s) => n + s.payload.facts.length, 0)} fact(s). ` +
        `Pass --submit to POST them.`,
    );
    return;
  }
  writeFileSync(statePath, `${JSON.stringify(summary.nextState, null, 2)}\n`, 'utf8');
  console.error(`[indexer] state written to ${statePath}`);
}

main().catch((e: unknown) => {
  console.error(`[indexer] fatal: ${(e as Error).message}`);
  process.exit(1);
});
