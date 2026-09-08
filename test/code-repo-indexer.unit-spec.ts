/**
 * Reference code-repository indexer (src/code-memory/repo-indexer).
 *
 * No network: the submission client is an interface and every test
 * drives a stub. No git binary is required either — `RepoSource` is an
 * interface, so the derivers run against an in-memory fixture. The one
 * suite that DOES need git (`git init` + real commits) is guarded by a
 * probe and skips when the binary is absent.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isGroundedSpan, normalizeForGrounding } from '../src/ai/extractor-internals/grounding';
import {
  DEFAULT_CAPS,
  type IndexerCaps,
  type RepoFact,
} from '../src/code-memory/repo-indexer/types';
import {
  FsRepoSource,
  parseCommitLog,
  type CommitRecord,
  type RepoFileRef,
  type RepoSource,
} from '../src/code-memory/repo-indexer/repo-source';
import {
  ownershipFromCodeowners,
  ownershipFromHistory,
  parseCodeowners,
} from '../src/code-memory/repo-indexer/core/ownership';
import {
  decisionsFromCommits,
  decisionsFromDocs,
} from '../src/code-memory/repo-indexer/core/decisions';
import {
  extractComments,
  warningSentences,
  warningsFromComments,
} from '../src/code-memory/repo-indexer/core/warnings';
import {
  JAVASCRIPT_MODULE,
  parseLockfileVersions,
  parseManifestDeps,
} from '../src/code-memory/repo-indexer/modules/javascript.module';
import {
  CONFIG_CATALOG_MODULE,
  DEFAULT_CONSTANTS_MODULE,
  isValueShaped,
  parseConfigCatalog,
  parseDefaultConstants,
} from '../src/code-memory/repo-indexer/modules/config.module';
import {
  assignPaths,
  moduleProducer,
  type EcosystemModule,
} from '../src/code-memory/repo-indexer/modules/module.types';
import { BUILTIN_MODULES, selectModules } from '../src/code-memory/repo-indexer/modules/registry';
import {
  applyGroundingFence,
  applyShapeFences,
  candidateIdOf,
  composeEvidenceDocuments,
  identify,
  toCandidatePayload,
} from '../src/code-memory/repo-indexer/bundle';
import { EMPTY_STATE, runIndexer, type RunState } from '../src/code-memory/repo-indexer/run';
import type {
  BrainClient,
  IngestDocumentInput,
  IngestedDocument,
  SubmissionOutcome,
} from '../src/code-memory/repo-indexer/brain-client';
import type { CandidatePayload } from '../src/code-memory/repo-indexer/bundle';

// ── fixtures ─────────────────────────────────────────────────────────

class FakeRepoSource implements RepoSource {
  constructor(
    private readonly files: Record<string, string>,
    private readonly commits: CommitRecord[] = [],
    private readonly headSha: string | null = 'head0000',
    private readonly changed: string[] | null = null,
  ) {}

  listFiles(): RepoFileRef[] {
    return Object.entries(this.files).map(([path, text]) => ({ path, bytes: text.length }));
  }

  readFile(path: string): string | null {
    return this.files[path] ?? null;
  }

  readCommits(opts: { since?: string | undefined; limit: number }): CommitRecord[] {
    return this.commits.slice(0, opts.limit);
  }

  head(): string | null {
    return this.headSha;
  }

  changedSince(): string[] | null {
    return this.changed;
  }
}

class StubBrainClient implements BrainClient {
  readonly documents: IngestDocumentInput[] = [];
  readonly payloads: CandidatePayload[] = [];
  conflictNext = false;

  ingestDocument(input: IngestDocumentInput): Promise<IngestedDocument> {
    this.documents.push(input);
    return Promise.resolve({
      documentId: `source_document:${this.documents.length}`,
      deduplicated: false,
    });
  }

  submitCandidates(_documentId: string, payload: CandidatePayload): Promise<SubmissionOutcome> {
    this.payloads.push(payload);
    return Promise.resolve({
      runId: 'indexer_run:1',
      staged: { entities: payload.entities.length, facts: payload.facts.length, relations: 0 },
      dropped: [],
      alreadyProcessed: this.conflictNext,
    });
  }
}

function commit(over: Partial<CommitRecord>): CommitRecord {
  return {
    sha: 'a'.repeat(40),
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    date: '2026-01-01T00:00:00Z',
    message: 'chore: touch',
    changedFiles: [],
    ...over,
  };
}

function fact(over: Partial<RepoFact> = {}): RepoFact {
  return {
    producer: 'core:warnings',
    subject: 'src/a.ts',
    subjectType: 'asset',
    kind: 'gotcha',
    object: 'beware: the resolver must never be called twice',
    derivation: 'quoted from a comment',
    evidence: {
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      excerpt: '// beware: the resolver must never be called twice',
    },
    confidence: 0.75,
    ...over,
  };
}

const caps: IndexerCaps = { ...DEFAULT_CAPS };

// ── ownership ────────────────────────────────────────────────────────

describe('ownership', () => {
  it('reads declared CODEOWNERS rules and strips the @ sigil', () => {
    const source = new FakeRepoSource({
      '.github/CODEOWNERS': ['# comment', '/src/fovea/ @mikefluff', 'docs @team-a @team-b'].join(
        '\n',
      ),
    });
    const facts = ownershipFromCodeowners(source);
    expect(facts.map((f) => [f.subject, f.object])).toEqual([
      ['src/fovea', 'mikefluff'],
      ['docs', 'team-a'],
    ]);
    expect(facts[1]?.derivation).toContain('declares 2 owners');
    expect(facts[0]?.evidence.excerpt).toBe('/src/fovea/ @mikefluff');
  });

  it('refuses glob patterns — a glob names no code anchor', () => {
    expect(parseCodeowners('*.ts @someone\nsrc/** @someone').length).toBe(0);
  });

  it('derives ownership from history only past both thresholds', () => {
    const commits = [
      commit({ sha: '1', authorName: 'Ada', changedFiles: ['src/pkg/a.ts'] }),
      commit({ sha: '2', authorName: 'Ada', changedFiles: ['src/pkg/b.ts'] }),
      commit({ sha: '3', authorName: 'Ada', changedFiles: ['src/pkg/c.ts'] }),
      commit({ sha: '4', authorName: 'Linus', changedFiles: ['src/pkg/d.ts'] }),
      // 'lonely' is touched twice only — under the min-commits threshold.
      commit({ sha: '5', authorName: 'Grace', changedFiles: ['lonely/x.ts'] }),
      commit({ sha: '6', authorName: 'Grace', changedFiles: ['lonely/y.ts'] }),
    ];
    const facts = ownershipFromHistory({ commits, caps, headSha: 'deadbeef' });
    const subjects = facts.map((f) => f.subject);
    expect(subjects).toContain('src/pkg');
    expect(subjects).not.toContain('lonely');
    const pkg = facts.find((f) => f.subject === 'src/pkg');
    expect(pkg?.object).toBe('Ada');
    // The RULE travels with the fact, not a bare authorship assertion.
    expect(pkg?.derivation).toContain('authored 3 of the 4 commits');
    expect(pkg?.derivation).toContain('not a declaration of ownership');
    expect(pkg?.confidence).toBeLessThan(0.9);
  });

  it('emits nothing when no author is dominant enough', () => {
    const commits = [
      commit({ sha: '1', authorName: 'Ada', changedFiles: ['src/split/a.ts'] }),
      commit({ sha: '2', authorName: 'Linus', changedFiles: ['src/split/b.ts'] }),
      commit({ sha: '3', authorName: 'Grace', changedFiles: ['src/split/c.ts'] }),
      commit({ sha: '4', authorName: 'Barbara', changedFiles: ['src/split/d.ts'] }),
    ];
    const facts = ownershipFromHistory({ commits, caps, headSha: null });
    expect(facts.find((f) => f.subject === 'src/split')).toBeUndefined();
  });
});

// ── dependencies (javascript module) ─────────────────────────────────

describe('javascript module', () => {
  const manifest = JSON.stringify({
    dependencies: { '@nestjs/common': '^11.1.29' },
    devDependencies: { jest: '30.0.0' },
    packageManager: 'pnpm@10.15.0',
    engines: { node: '>=20' },
  });
  const lock = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    "      '@nestjs/common':",
    '        specifier: ^11.1.29',
    '        version: 11.1.29(rxjs@7.8.2)',
    '',
    'packages:',
    '',
    '  unrelated@1.0.0:',
    '    resolution: {integrity: sha512-x}',
  ].join('\n');

  it('parses declared dependencies including tool pins', () => {
    const deps = parseManifestDeps(manifest);
    expect(deps).toEqual(
      expect.arrayContaining([
        { name: '@nestjs/common', spec: '^11.1.29', section: 'dependencies' },
        { name: 'jest', spec: '30.0.0', section: 'devDependencies' },
        { name: 'pnpm', spec: '10.15.0', section: 'packageManager' },
        { name: 'node', spec: '>=20', section: 'engines' },
      ]),
    );
  });

  it('reads exact installed versions out of the pnpm importers block', () => {
    const resolved = parseLockfileVersions(lock);
    expect(resolved.get('@nestjs/common')).toBe('11.1.29');
    expect(resolved.has('unrelated')).toBe(false);
  });

  it('prefers the lockfile version and falls back to the declared range', () => {
    const source = new FakeRepoSource({ 'package.json': manifest, 'pnpm-lock.yaml': lock });
    const facts = JAVASCRIPT_MODULE.extract({
      paths: ['package.json', 'pnpm-lock.yaml'],
      source,
      caps,
    });
    const nest = facts.find((f) => f.subject === '@nestjs/common');
    expect(nest?.object).toBe('11.1.29');
    expect(nest?.derivation).toContain('Exact installed version');
    expect(nest?.producer).toBe(moduleProducer(JAVASCRIPT_MODULE));

    const jest = facts.find((f) => f.subject === 'jest');
    expect(jest?.object).toBe('30.0.0');
    expect(jest?.derivation).toContain('no lockfile resolution');
    expect(jest?.evidence.path).toBe('package.json');
    expect(jest?.evidence.startLine).toBeGreaterThan(0);
  });

  it('emits nothing for a malformed manifest rather than guessing', () => {
    expect(parseManifestDeps('{ not json').length).toBe(0);
  });
});

// ── flag defaults (config modules) ───────────────────────────────────

describe('config modules', () => {
  it('accepts value-shaped defaults and rejects prose', () => {
    expect(isValueShaped('0')).toBe(true);
    expect(isValueShaped('true')).toBe(true);
    expect(isValueShaped('strict')).toBe(true);
    expect(isValueShaped('Xenova/bert-base-multilingual-cased-ner-hrl')).toBe(true);
    expect(isValueShaped('every duration in milliseconds')).toBe(false);
    expect(isValueShaped('the timeout, in ms')).toBe(false);
    expect(isValueShaped('')).toBe(false);
    expect(isValueShaped('x'.repeat(65))).toBe(false);
  });

  it('reads catalogue rows and skips null defaults', () => {
    const catalogue = [
      'export const CONFIG_CATALOG = [',
      '  {',
      "    key: 'EXTRACTOR_SC_PASSES',",
      "    defaultValue: '1',",
      '  },',
      '  {',
      "    key: 'OPENAI_API_KEY',",
      '    defaultValue: null,',
      '  },',
      '];',
    ].join('\n');
    const rows = parseConfigCatalog(catalogue);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['EXTRACTOR_SC_PASSES', '1'],
      ['OPENAI_API_KEY', null],
    ]);
    const facts = CONFIG_CATALOG_MODULE.extract({
      paths: ['src/admin/config-catalog.data.ts'],
      source: new FakeRepoSource({ 'src/admin/config-catalog.data.ts': catalogue }),
      caps,
    });
    expect(facts.map((f) => [f.subject, f.object])).toEqual([['EXTRACTOR_SC_PASSES', '1']]);
  });

  it('reads DEFAULT_* literals but never expressions', () => {
    const src = [
      "export const DEFAULT_MODE = 'strict';",
      'const DEFAULT_TIMEOUT_MS = 10_000;',
      'const DEFAULT_FROM_ENV = process.env.X ?? 5;',
      'const MAX_RETRIES = 3;',
    ].join('\n');
    const parsed = parseDefaultConstants(src);
    expect(parsed.map((c) => [c.name, c.value])).toEqual([
      ['DEFAULT_MODE', 'strict'],
      ['DEFAULT_TIMEOUT_MS', '10_000'],
    ]);
  });

  it('drops a prose "default" client-side instead of sending it', () => {
    const prose = fact({
      kind: 'default_value',
      subject: 'PAYMENT_NORMALIZER',
      object: 'every duration in milliseconds',
    });
    const { kept, dropped } = applyShapeFences({
      facts: identify([prose]),
      packId: 'code_memory',
      caps,
      alreadySubmitted: new Set(),
    });
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('not_value_shaped');
  });
});

// ── module registry ──────────────────────────────────────────────────

describe('module registry', () => {
  it('resolves a contested path deterministically by priority', () => {
    const path = 'src/admin/config-catalog.data.ts';
    expect(CONFIG_CATALOG_MODULE.claims(path)).toBe(true);
    expect(DEFAULT_CONSTANTS_MODULE.claims(path)).toBe(true);
    expect(CONFIG_CATALOG_MODULE.priority).toBeGreaterThan(DEFAULT_CONSTANTS_MODULE.priority);

    const forward = assignPaths([CONFIG_CATALOG_MODULE, DEFAULT_CONSTANTS_MODULE], [path]);
    const reversed = assignPaths([DEFAULT_CONSTANTS_MODULE, CONFIG_CATALOG_MODULE], [path]);
    // Registration order must not change the outcome.
    expect(forward.get(CONFIG_CATALOG_MODULE.id)).toEqual([path]);
    expect(reversed.get(CONFIG_CATALOG_MODULE.id)).toEqual([path]);
    expect(forward.get(DEFAULT_CONSTANTS_MODULE.id)).toBeUndefined();
  });

  it('is explicit — selectModules rejects an unknown id', () => {
    expect(selectModules(undefined)).toBe(BUILTIN_MODULES);
    expect(selectModules(['javascript']).map((m) => m.id)).toEqual(['javascript']);
    expect(() => selectModules(['python'])).toThrow(/unknown ecosystem module/);
  });

  it('a third-party module needs no core change to participate', () => {
    const goModule: EcosystemModule = {
      id: 'go',
      version: '0.1.0',
      description: 'go.mod pins',
      priority: 50,
      claims: (p) => p.endsWith('go.mod'),
      extract: ({ paths }) =>
        paths.map((p) =>
          fact({
            producer: 'module:go@0.1.0',
            subject: 'rsc.io/quote',
            kind: 'depends_on_version',
            object: 'v1.5.2',
            evidence: { path: p, startLine: 3, endLine: 3, excerpt: 'require rsc.io/quote v1.5.2' },
          }),
        ),
    };
    const assigned = assignPaths([...BUILTIN_MODULES, goModule], ['go.mod', 'package.json']);
    expect(assigned.get('go')).toEqual(['go.mod']);
    expect(assigned.get('javascript')).toEqual(['package.json']);
  });
});

// ── decisions ────────────────────────────────────────────────────────

describe('decisions', () => {
  it('anchors a commit decision on a path the message names', () => {
    const facts = decisionsFromCommits({
      commits: [
        commit({
          sha: 'f'.repeat(40),
          message:
            'We decided to resolve all facts through one gateway in src/ingest/resolver.ts.\n\nbecause 21 positional args drifted between the call-sites of src/ingest/resolver.ts.',
          changedFiles: ['a.ts', 'b.ts', 'c.ts'],
        }),
      ],
      caps,
    });
    const decided = facts.find((f) => f.kind === 'decided');
    expect(decided?.subject).toBe('src/ingest/resolver.ts');
    expect(decided?.object).toContain('resolve all facts through one gateway');
    expect(decided?.derivation).toContain('names the anchor');
    expect(facts.find((f) => f.kind === 'because')?.object).toContain('positional args drifted');
  });

  it('falls back to the single changed file, and refuses a multi-file commit', () => {
    const single = decisionsFromCommits({
      commits: [
        commit({
          message: 'We decided to cache answers per tenant rather than per request.',
          changedFiles: ['src/answers/cache.ts'],
        }),
      ],
      caps,
    });
    expect(single[0]?.subject).toBe('src/answers/cache.ts');
    expect(single[0]?.derivation).toContain('changed exactly one file');

    const ambiguous = decisionsFromCommits({
      commits: [
        commit({
          message: 'We decided to cache answers per tenant rather than per request.',
          changedFiles: ['a.ts', 'b.ts'],
        }),
      ],
      caps,
    });
    expect(ambiguous).toHaveLength(0);
  });

  it('never reads a decision out of a message that states none', () => {
    const facts = decisionsFromCommits({
      commits: [
        commit({
          message: 'refactor: rename the resolver and tidy the imports across the module',
          changedFiles: ['src/ingest/resolver.ts'],
        }),
      ],
      caps,
    });
    expect(facts).toHaveLength(0);
  });

  it('reads an ADR Decision section, anchored on the document itself', () => {
    const adr = [
      '# ADR 7: one gateway',
      '',
      '## Context',
      '',
      'Twenty-one positional arguments had drifted between the call-sites over two quarters.',
      '',
      '## Decision',
      '',
      'All fact writes go through a single resolver gateway from now on.',
      '',
      '## Consequences',
      '',
      'Call-sites need updating.',
    ].join('\n');
    const facts = decisionsFromDocs(
      new FakeRepoSource({ 'docs/adr/0007-gateway.md': adr, 'src/x.ts': 'const a = 1;' }),
      ['docs/adr/0007-gateway.md', 'src/x.ts'],
    );
    const decided = facts.find((f) => f.kind === 'decided');
    expect(decided?.subject).toBe('docs/adr/0007-gateway.md');
    expect(decided?.object).toBe(
      'All fact writes go through a single resolver gateway from now on.',
    );
    const because = facts.find((f) => f.kind === 'because');
    expect(because?.object).toContain('positional arguments had drifted');
    expect(decided?.evidence.startLine).toBeGreaterThan(0);
  });
});

// ── warnings ─────────────────────────────────────────────────────────

describe('warnings', () => {
  it('splits line and block comments into span-carrying blocks', () => {
    const src = [
      'const a = 1;',
      '/**',
      ' * Beware: the worker must be stubbed or the suite aborts.',
      ' */',
      'function f() {}',
      '// plain trailing note',
    ].join('\n');
    const blocks = extractComments(src, '.ts');
    expect(blocks[0]?.startLine).toBe(2);
    expect(blocks[0]?.endLine).toBe(4);
    expect(blocks[0]?.text).toContain('Beware:');
  });

  it('classifies explicit traps as gotcha and explicit rules as invariant', () => {
    expect(
      warningSentences({
        text: 'Gotcha: pnpm test -- --testPathPattern does not work in this repo.',
        startLine: 1,
        endLine: 1,
      })[0]?.kind,
    ).toBe('gotcha');
    expect(
      warningSentences({
        text: 'Every duration must be stored in milliseconds, never seconds.',
        startLine: 1,
        endLine: 1,
      })[0]?.kind,
    ).toBe('invariant');
  });

  it('ignores a marker that is merely mentioned, and tooling noise', () => {
    expect(
      warningSentences({
        text: 'Decisions, rationale, invariants, gotchas — anchored to code anchors.',
        startLine: 1,
        endLine: 1,
      }),
    ).toHaveLength(0);
    expect(
      warningSentences({
        text: 'eslint-disable-next-line max-params -- this must stay one call.',
        startLine: 1,
        endLine: 1,
      }),
    ).toHaveLength(0);
  });

  it('grounds every warning in the span it reports', () => {
    const file = [
      'export function run() {',
      '  // Gotcha: the lease expires after 30 minutes, so heartbeat well inside it.',
      '  return 1;',
      '}',
    ].join('\n');
    const facts = warningsFromComments({
      source: new FakeRepoSource({ 'src/run.ts': file }),
      paths: ['src/run.ts'],
      caps,
    });
    expect(facts).toHaveLength(1);
    const w = facts[0] as RepoFact;
    expect(w.kind).toBe('gotcha');
    expect(w.evidence.path).toBe('src/run.ts');
    expect(w.evidence.startLine).toBe(2);
    // The reported span really does contain the recorded value.
    const span = file
      .split('\n')
      .slice(w.evidence.startLine - 1, w.evidence.endLine)
      .join('\n');
    expect(isGroundedSpan(normalizeForGrounding(span), normalizeForGrounding(w.object))).toBe(true);
  });

  it('does not scan extensions it has no comment syntax for', () => {
    expect(extractComments('# never do this in a config that must stay stable', '.toml')).toEqual(
      [],
    );
  });
});

// ── bundle: identity, fences, grounding ──────────────────────────────

describe('bundle', () => {
  it('derives a stable candidate id from (path, kind, content)', () => {
    const a = candidateIdOf(fact());
    expect(candidateIdOf(fact())).toBe(a);
    expect(candidateIdOf(fact({ kind: 'invariant' }))).not.toBe(a);
    expect(candidateIdOf(fact({ object: 'something else entirely' }))).not.toBe(a);
    expect(candidateIdOf(fact({ evidence: { ...fact().evidence, path: 'src/b.ts' } }))).not.toBe(a);
  });

  it('drops a predicate outside the pack namespace before it is sent', () => {
    const squatter = fact({ kind: 'other_pack__thing' as RepoFact['kind'] });
    const { kept, dropped } = applyShapeFences({
      facts: identify([squatter]),
      packId: 'code_memory',
      caps,
      alreadySubmitted: new Set(),
    });
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('namespace_fence');
    expect(dropped[0]?.detail).toBe('code_memory__other_pack__thing');
  });

  it('keeps only the strongest claim for a single_active predicate', () => {
    const weak = fact({
      kind: 'invariant',
      object: 'the resolver must run first',
      confidence: 0.6,
    });
    const strong = fact({
      kind: 'invariant',
      object: 'the resolver must never be reentered',
      confidence: 0.9,
      evidence: {
        path: 'src/a.ts',
        startLine: 9,
        endLine: 9,
        excerpt: '// must never be reentered',
      },
    });
    const { kept, dropped } = applyShapeFences({
      facts: identify([weak, strong]),
      packId: 'code_memory',
      caps,
      alreadySubmitted: new Set(),
    });
    expect(kept.map((f) => f.object)).toEqual(['the resolver must never be reentered']);
    expect(dropped[0]?.reason).toBe('single_active_collision');
  });

  it('composes an evidence document each fact grounds against', () => {
    const facts = identify([fact(), fact({ kind: 'because', object: 'the lease is 30 minutes' })]);
    const [doc] = composeEvidenceDocuments({
      facts,
      packId: 'code_memory',
      caps,
      repoLabel: 'fixture',
      headSha: 'abc123',
    });
    expect(doc?.text).toContain('code_memory__gotcha:');
    expect(doc?.text).toContain('derivation:');
    expect(doc?.text).toContain('evidence: src/a.ts:1-1');
    const grounded = applyGroundingFence(doc!);
    expect(grounded.dropped).toHaveLength(0);
    expect(grounded.kept).toHaveLength(2);
  });

  it('drops an ungrounded value rather than letting the server reject it', () => {
    const doc = {
      text: '# Repository evidence\n### src/a.ts\nnothing else here\n',
      facts: identify([fact({ object: 'a value that appears nowhere in the document' })]),
    };
    const grounded = applyGroundingFence(doc);
    expect(grounded.kept).toHaveLength(0);
    expect(grounded.dropped[0]?.reason).toBe('ungrounded_value');
  });

  it('splits documents at the per-document fact cap', () => {
    const many = identify(
      Array.from({ length: 5 }, (_v, i) =>
        fact({
          kind: 'gotcha',
          object: `beware: trap number ${i} is easy to hit`,
          evidence: { path: `src/f${i}.ts`, startLine: 1, endLine: 1, excerpt: `// trap ${i}` },
        }),
      ),
    );
    const docs = composeEvidenceDocuments({
      facts: many,
      packId: 'code_memory',
      caps: { ...caps, maxFactsPerDocument: 2 },
      repoLabel: 'fixture',
      headSha: null,
    });
    expect(docs.map((d) => d.facts.length)).toEqual([2, 2, 1]);
  });

  it('collapses repeated subjects into one entity in the payload', () => {
    const payload = toCandidatePayload(
      identify([
        fact({ kind: 'gotcha', object: 'beware: one' }),
        fact({ kind: 'because', object: 'two' }),
      ]),
      'code_memory',
    );
    expect(payload.entities).toEqual([{ name: 'src/a.ts', type: 'asset' }]);
    expect(payload.facts.map((f) => f.predicate)).toEqual([
      'code_memory__gotcha',
      'code_memory__because',
    ]);
    expect(payload.facts.every((f) => f.entityIndex === 0)).toBe(true);
    expect(payload.facts[0]?.clause).toContain('beware');
  });
});

// ── the runner ───────────────────────────────────────────────────────

const RUNNER_FILES: Record<string, string> = {
  '.github/CODEOWNERS': '/src/ @ada\n',
  'package.json': JSON.stringify({ dependencies: { left_pad: '1.3.0' } }),
  'src/worker.ts': '// Gotcha: the worker must be stubbed or the suite aborts here.\n',
};

function runnerOptions(over: Partial<Parameters<typeof runIndexer>[0]> = {}) {
  return {
    source: new FakeRepoSource(RUNNER_FILES, [], 'head0000'),
    client: new StubBrainClient(),
    caps,
    packId: 'code_memory',
    repoLabel: 'fixture',
    modules: BUILTIN_MODULES,
    state: { ...EMPTY_STATE },
    ...over,
  };
}

describe('runIndexer', () => {
  it('submits core + module facts, and produces output with no ecosystem module', async () => {
    const client = new StubBrainClient();
    const full = await runIndexer(runnerOptions({ client }));
    expect(full.submitted).toBeGreaterThan(0);
    const predicates = client.payloads.flatMap((p) => p.facts.map((f) => f.predicate));
    expect(predicates).toEqual(
      expect.arrayContaining([
        'code_memory__owns',
        'code_memory__gotcha',
        'code_memory__depends_on_version',
      ]),
    );

    // A repository whose ecosystem has no module still gets the core.
    const coreOnly = new StubBrainClient();
    const bare = await runIndexer(runnerOptions({ client: coreOnly, modules: [] }));
    expect(bare.submitted).toBeGreaterThan(0);
    const bareKinds = coreOnly.payloads.flatMap((p) => p.facts.map((f) => f.predicate));
    expect(bareKinds).toContain('code_memory__owns');
    expect(bareKinds).not.toContain('code_memory__depends_on_version');
  });

  it('is idempotent — a second run over an unchanged repo submits nothing', async () => {
    const first = await runIndexer(runnerOptions());
    expect(first.submitted).toBeGreaterThan(0);

    const client = new StubBrainClient();
    const second = await runIndexer(runnerOptions({ client, state: first.nextState }));
    expect(second.submitted).toBe(0);
    expect(second.documents).toBe(0);
    expect(client.documents).toHaveLength(0);
    expect(second.dropped.every((d) => d.reason === 'already_submitted')).toBe(true);
    // And the state does not grow.
    expect(second.nextState.submitted.sort()).toEqual(first.nextState.submitted.sort());
  });

  it('records an already-processed slot instead of re-offering it forever', async () => {
    const client = new StubBrainClient();
    client.conflictNext = true;
    const summary = await runIndexer(runnerOptions({ client }));
    expect(summary.alreadyProcessed).toBe(1);
    expect(summary.nextState.submitted.length).toBeGreaterThan(0);
  });

  it('narrows the working-tree scan to the since-commit delta', async () => {
    const client = new StubBrainClient();
    const summary = await runIndexer(
      runnerOptions({
        client,
        source: new FakeRepoSource(RUNNER_FILES, [], 'head0000', ['src/worker.ts']),
        since: 'head0000~5',
      }),
    );
    expect(summary.incremental).toBe(true);
    expect(summary.filesScanned).toBe(1);
    const predicates = client.payloads.flatMap((p) => p.facts.map((f) => f.predicate));
    expect(predicates).toContain('code_memory__gotcha');
    // package.json was not in the delta, so no dependency claim this run.
    expect(predicates).not.toContain('code_memory__depends_on_version');
  });

  it('falls back to a full walk when the since-commit cannot be resolved', async () => {
    const lines: string[] = [];
    const summary = await runIndexer(
      runnerOptions({
        source: new FakeRepoSource(RUNNER_FILES, [], 'head0000', null),
        since: 'nonexistent',
        log: (l) => lines.push(l),
      }),
    );
    expect(summary.incremental).toBe(false);
    expect(summary.filesScanned).toBe(Object.keys(RUNNER_FILES).length);
    expect(lines.join(' ')).toContain('falling back to a full walk');
  });
});

// ── the filesystem/git layer ─────────────────────────────────────────

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('parseCommitLog', () => {
  it('parses the record/field-separated log format', () => {
    const raw =
      '\x1eabc\x1fAda\x1fada@example.com\x1f2026-01-01T00:00:00Z\x1ffeat: x\x1f\nsrc/a.ts\n';
    const [c] = parseCommitLog(raw);
    expect(c?.sha).toBe('abc');
    expect(c?.authorName).toBe('Ada');
    expect(c?.changedFiles).toEqual(['src/a.ts']);
  });
});

(hasGit() ? describe : describe.skip)('FsRepoSource over a real checkout', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'repo-indexer-'));
    const write = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text, 'utf8');
    };
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ada@example.com');
    git('config', 'user.name', 'Ada');
    git('config', 'commit.gpgsign', 'false');

    write('src/keep.ts', '// Beware: this module must never be imported twice.\n');
    write('node_modules/skip/index.js', '// Gotcha: this should never be indexed at all.\n');
    write('dist/skip.js', '// Gotcha: build output must never be indexed.\n');
    write('bin/blob.dat', 'A B');
    git('add', '-A');
    git('commit', '-qm', 'chore: first');

    write('src/second.ts', '// Gotcha: the second file must be seen only by the delta run.\n');
    git('add', '-A');
    git('commit', '-qm', 'chore: second');

    write('src/third.ts', '// Beware: the third module must be registered before use.\n');
    git('add', '-A');
    git('commit', '-qm', 'We decided to add a third module in src/third.ts.');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks the tree bounded, skipping build output and binaries', () => {
    const source = new FsRepoSource({ root, maxFiles: 100, maxFileBytes: 512_000 });
    const paths = source.listFiles().map((f) => f.path);
    expect(paths).toContain('src/keep.ts');
    expect(paths).toContain('src/second.ts');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
    expect(paths).not.toContain('bin/blob.dat');
  });

  it('honours maxFiles as a hard stop', () => {
    expect(new FsRepoSource({ root, maxFiles: 1, maxFileBytes: 512_000 }).listFiles()).toHaveLength(
      1,
    );
  });

  it('reads history and resolves a since-commit delta', () => {
    const source = new FsRepoSource({ root, maxFiles: 100, maxFileBytes: 512_000 });
    expect(source.head()).toMatch(/^[0-9a-f]{40}$/);
    const commits = source.readCommits({ since: undefined, limit: 10 });
    expect(commits).toHaveLength(3);
    expect(commits[0]?.authorName).toBe('Ada');
    expect(source.changedSince('HEAD~1')).toEqual(['src/third.ts']);
    expect(source.changedSince('no-such-ref')).toBeNull();
  });

  it('derives a commit decision anchored on the single changed file', () => {
    const source = new FsRepoSource({ root, maxFiles: 100, maxFileBytes: 512_000 });
    const facts = decisionsFromCommits({
      commits: source.readCommits({ since: 'HEAD~1', limit: 10 }),
      caps,
    });
    expect(facts.find((f) => f.kind === 'decided')?.subject).toBe('src/third.ts');
  });

  it('runs end to end against the checkout without touching the network', async () => {
    const client = new StubBrainClient();
    const state: RunState = { ...EMPTY_STATE };
    const summary = await runIndexer({
      source: new FsRepoSource({ root, maxFiles: 100, maxFileBytes: 512_000 }),
      client,
      caps,
      packId: 'code_memory',
      repoLabel: 'fixture-repo',
      modules: BUILTIN_MODULES,
      state,
    });
    expect(summary.submitted).toBeGreaterThan(0);
    expect(client.payloads.flatMap((p) => p.facts.map((f) => f.predicate))).toContain(
      'code_memory__gotcha',
    );
    // Ownership came from history (no CODEOWNERS in the fixture).
    expect(summary.byProducer['core:ownership']).toBeGreaterThan(0);
  });
});
