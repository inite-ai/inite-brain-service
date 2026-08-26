/**
 * evidence-ref (0109 companion): record-prefix parsing, the outcome
 * binding rule (assets only — fragments roll up), the cap-64 union
 * idiom, and the runtime pin that SOURCE_EVIDENCE_KINDS stays in sync
 * with the ingest path's EVIDENCE_KINDS vocabulary.
 */
import {
  SOURCE_EVIDENCE_KINDS,
  outcomeSubjectFor,
  parseRecordRef,
  unionEvidenceRefs,
} from '../src/common/evidence-ref';
import { evidenceValidationError } from '../src/ingest/ingest-utils';

describe('parseRecordRef', () => {
  it('dispatches the three record prefixes into typed refs', () => {
    expect(parseRecordRef('episode:abc')).toEqual({ kind: 'episode', episodeId: 'episode:abc' });
    expect(parseRecordRef('evidence_fragment:f1')).toEqual({
      kind: 'fragment',
      fragmentId: 'evidence_fragment:f1',
    });
    expect(parseRecordRef('evidence_asset:a1')).toEqual({
      kind: 'asset',
      assetId: 'evidence_asset:a1',
    });
  });

  it('returns null for anything else — never a guess', () => {
    for (const raw of ['knowledge_fact:x', 'evidence_assetx:1', 'a1', '', 'fs://co/x']) {
      expect(parseRecordRef(raw)).toBeNull();
    }
  });
});

describe('outcomeSubjectFor (the 0107 binding rule)', () => {
  it('asset → evidence subject on the asset id', () => {
    expect(outcomeSubjectFor({ kind: 'asset', assetId: 'evidence_asset:a1' })).toEqual({
      subjectKind: 'evidence',
      subjectId: 'evidence_asset:a1',
    });
  });

  it('fragment rolls up to the parent asset — null without one', () => {
    expect(
      outcomeSubjectFor({
        kind: 'fragment',
        fragmentId: 'evidence_fragment:f1',
        assetId: 'evidence_asset:a1',
      }),
    ).toEqual({ subjectKind: 'evidence', subjectId: 'evidence_asset:a1' });
    expect(outcomeSubjectFor({ kind: 'fragment', fragmentId: 'evidence_fragment:f1' })).toBeNull();
  });

  it('episode binds as an episode subject; external binds to nothing', () => {
    expect(outcomeSubjectFor({ kind: 'episode', episodeId: 'episode:e1' })).toEqual({
      subjectKind: 'episode',
      subjectId: 'episode:e1',
    });
    expect(outcomeSubjectFor({ kind: 'external', sourceKind: 'url', ref: 'https://x' })).toBeNull();
  });
});

describe('unionEvidenceRefs (episode-ids idiom, widened)', () => {
  it('unions, coerces, filters to known prefixes, dedupes in member order', () => {
    expect(
      unionEvidenceRefs([
        ['evidence_asset:a1', 'episode:e1', 'knowledge_fact:x', 42],
        'not-a-list',
        ['evidence_fragment:f1', 'evidence_asset:a1'],
      ]),
    ).toEqual(['evidence_asset:a1', 'episode:e1', 'evidence_fragment:f1']);
  });

  it('caps at 64', () => {
    const many = [Array.from({ length: 100 }, (_, i) => `evidence_asset:a${i}`)];
    expect(unionEvidenceRefs(many)).toHaveLength(64);
  });
});

describe('SOURCE_EVIDENCE_KINDS ↔ ingest EVIDENCE_KINDS sync pin', () => {
  // EVIDENCE_KINDS (ingest-utils.ts) is an unexported Set, so the pin is
  // behavioral: every kind the ref module exports must pass the ingest
  // validator, and a kind it does not export must fail it. The DTO-side
  // direction is a compile-time exhaustiveness check in evidence-ref.ts.
  it('every exported kind validates on the ingest path', () => {
    for (const kind of SOURCE_EVIDENCE_KINDS) {
      expect(evidenceValidationError([{ kind, ref: 'ref-1' }])).toBeNull();
    }
  });

  it('a kind outside the vocabulary fails the ingest validator', () => {
    expect(evidenceValidationError([{ kind: 'bogus', ref: 'ref-1' }])).toMatch(/kind/);
  });

  it('the exported list is exactly the 7-value vocabulary', () => {
    expect([...SOURCE_EVIDENCE_KINDS].sort()).toEqual(
      ['commit', 'conversation', 'document', 'event', 'message', 'other', 'url'].sort(),
    );
  });
});
