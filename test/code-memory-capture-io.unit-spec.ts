/**
 * Code-memory Phase 1 — IO-layer unit coverage: LLM-extraction parsing +
 * grounding, the HTTP sink request shape, and the git-log parser. The OpenAI
 * call and the network are behind injected seams, so these run offline.
 */
import {
  buildExtractionPrompt,
  parseCandidates,
} from '../src/code-memory/capture/llm-extractor';
import { HttpDecisionSink } from '../src/code-memory/capture/http-sink';
import { parseGitLog } from '../src/code-memory/capture/git-commits';
import type { CommitInput } from '../src/code-memory/capture/types';

const COMMIT: CommitInput = {
  sha: 'f0e824b1',
  message: 'refactor: split IngestService\n\nWhy: 21 positional args drifted.',
  changedFiles: ['src/ingest/fact-resolver.service.ts', 'src/ingest/ingest.service.ts'],
  authorDate: '2026-06-28T10:00:00Z',
};

describe('buildExtractionPrompt', () => {
  it('includes the message and constrains anchors to changed files', () => {
    const { system, user } = buildExtractionPrompt(COMMIT);
    expect(system).toMatch(/STRICT JSON/);
    expect(user).toContain('21 positional args drifted');
    expect(user).toContain('- src/ingest/fact-resolver.service.ts');
  });
});

describe('parseCandidates — grounding', () => {
  it('parses {decisions:[...]} and stamps commit + validFrom', () => {
    const raw = JSON.stringify({
      decisions: [
        {
          kind: 'decided',
          text: 'Route every write through one gateway',
          anchor: 'src/ingest/fact-resolver.service.ts',
          confidence: 0.9,
        },
      ],
    });
    const out = parseCandidates(raw, COMMIT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'decided',
      anchor: 'src/ingest/fact-resolver.service.ts',
      commit: 'f0e824b1',
      validFrom: '2026-06-28T10:00:00Z',
      confidence: 0.9,
    });
  });

  it('drops a candidate whose anchor is not a changed file (multi-file commit)', () => {
    const raw = JSON.stringify({
      decisions: [
        { kind: 'gotcha', text: 'g', anchor: 'src/not/touched.ts' },
      ],
    });
    expect(parseCandidates(raw, COMMIT)).toHaveLength(0);
  });

  it('re-anchors to the sole changed file when the model picked a wrong path', () => {
    const single: CommitInput = { ...COMMIT, changedFiles: ['src/only.ts'] };
    const raw = JSON.stringify({
      decisions: [{ kind: 'invariant', text: 'must hold', anchor: 'whatever.ts' }],
    });
    const out = parseCandidates(raw, single);
    expect(out).toHaveLength(1);
    expect(out[0].anchor).toBe('src/only.ts');
  });

  it('parses fenced ```json``` and skips invalid kinds', () => {
    const raw =
      '```json\n{"decisions":[{"kind":"nonsense","text":"x","anchor":"src/ingest/ingest.service.ts"},{"kind":"because","text":"real","anchor":"src/ingest/ingest.service.ts"}]}\n```';
    const out = parseCandidates(raw, COMMIT);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('because');
  });

  it('returns [] on unparseable output', () => {
    expect(parseCandidates('the model refused', COMMIT)).toEqual([]);
  });
});

describe('HttpDecisionSink', () => {
  it('POSTs /v1/ingest/fact with code anchor + provenance', async () => {
    const calls: any[] = [];
    const fetchImpl = (url: string, init: any) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ outcome: 'INSERTED' }),
      });
    };
    const sink = new HttpDecisionSink({
      baseUrl: 'https://brain.test',
      apiKey: 'k',
      fetchImpl,
    });
    const out = await sink.record({
      kind: 'decided',
      text: 'one gateway',
      anchor: 'src/ingest/fact-resolver.service.ts',
      commit: 'f0e824b1',
      location: 'src/ingest/fact-resolver.service.ts:145',
      validFrom: '2026-06-28T10:00:00Z',
      confidence: 0.9,
    });
    expect(out.outcome).toBe('INSERTED');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://brain.test/v1/ingest/fact');
    expect(calls[0].init.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(calls[0].init.body);
    expect(body.entityRef).toEqual({
      vertical: 'code',
      id: 'src/ingest/fact-resolver.service.ts',
    });
    expect(body.predicate).toBe('code_memory__decided');
    expect(body.source.eventId).toBe('f0e824b1');
    expect(body.source.recorder).toBe('code_memory_capture');
    expect(body.source.messageId).toBe('src/ingest/fact-resolver.service.ts:145');
  });

  it('throws on a non-ok response', async () => {
    const sink = new HttpDecisionSink({
      baseUrl: 'https://brain.test',
      apiKey: 'k',
      fetchImpl: () =>
        Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    });
    await expect(
      sink.record({
        kind: 'gotcha',
        text: 'g',
        anchor: 'a.ts',
        commit: 'c',
        validFrom: '2026-06-28T10:00:00Z',
      }),
    ).rejects.toThrow(/503/);
  });
});

describe('parseGitLog', () => {
  it('parses sha / authorDate / message / changed files', () => {
    const FS = '\x1f';
    const RS = '\x1e';
    const raw =
      `${RS}f0e824b${FS}2026-06-28T10:00:00Z${FS}refactor: split service\n\nWhy: drift.${FS}\n` +
      `src/ingest/fact-resolver.service.ts\nsrc/ingest/ingest.service.ts\n` +
      `${RS}a1211e8${FS}2026-06-27T09:00:00Z${FS}chore: bump${FS}\npackage.json\n`;
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe('f0e824b');
    expect(commits[0].authorDate).toBe('2026-06-28T10:00:00Z');
    expect(commits[0].message).toMatch(/split service/);
    expect(commits[0].changedFiles).toEqual([
      'src/ingest/fact-resolver.service.ts',
      'src/ingest/ingest.service.ts',
    ]);
    expect(commits[1].changedFiles).toEqual(['package.json']);
  });

  it('returns [] on empty input', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});
