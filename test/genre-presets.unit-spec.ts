import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
  type RetrievalProfile,
} from '../src/search/retrieval-profile';
import { GENRE_PRESETS } from '../src/search/genre-presets';

/**
 * Genre preset layer (genre-presets.ts): each genre ships tuned
 * defaults for the measured levers; explicit configuration always wins.
 *
 * Precedence under test (strict, per field):
 *   per-company overlay field > explicit env key > genre preset >
 *   code default
 * plus: a company overlay that changes `genre` re-derives the
 * preset-backed base for THAT genre before the remaining overlay
 * fields apply.
 */

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

/** Wire shape for full-profile equality: lanes as a sorted array. */
const wire = (p: RetrievalProfile) => ({ ...p, lanes: [...p.lanes].sort() });

describe('genre presets — default genre', () => {
  it('the default genre (assistant_chat) gets its preset', () => {
    const p = resolveRetrievalProfile(env({}));
    expect(p.genre).toBe('assistant_chat');
    expect(p.sceneTraces).toBe(true);
    expect(p.abstentionCalibration).toBe('verifier');
  });

  it('RETRIEVAL_GENRE=dialogue gets the dialogue preset', () => {
    const p = resolveRetrievalProfile(env({ RETRIEVAL_GENRE: 'dialogue' }));
    expect(p.verbatimEvidence).toBe('always');
    expect(p.dateAnchoring).toBe('none');
    // Dialogue does NOT inherit the assistant_chat levers.
    expect(p.sceneTraces).toBe(false);
    expect(p.abstentionCalibration).toBe('off');
  });
});

describe('genre presets — explicit env beats preset', () => {
  it('enum key set → env wins over the preset', () => {
    expect(
      resolveRetrievalProfile(
        env({
          RETRIEVAL_GENRE: 'dialogue',
          RETRIEVAL_VERBATIM_EVIDENCE: 'shape_conditioned',
        }),
      ).verbatimEvidence,
    ).toBe('shape_conditioned');
    expect(
      resolveRetrievalProfile(
        env({
          RETRIEVAL_GENRE: 'dialogue',
          RETRIEVAL_DATE_ANCHORING: 'absolute',
        }),
      ).dateAnchoring,
    ).toBe('absolute');
    expect(
      resolveRetrievalProfile(env({ RETRIEVAL_ABSTENTION_CALIBRATION: 'off' }))
        .abstentionCalibration,
    ).toBe('off');
  });

  it("boolean key explicitly '0' beats a preset-on (unset defers)", () => {
    // assistant_chat presets sceneTraces=true; an explicit 0 wins.
    expect(resolveRetrievalProfile(env({ RETRIEVAL_SCENE_TRACES: '0' })).sceneTraces).toBe(false);
    expect(resolveRetrievalProfile(env({ RETRIEVAL_SCENE_TRACES: '1' })).sceneTraces).toBe(true);
    expect(resolveRetrievalProfile(env({})).sceneTraces).toBe(true);
  });

  it('legacy SYNTHESIZE_DATE_CONTEXT set to ANY value is explicit', () => {
    // Explicit legacy ON beats the dialogue preset ('none').
    expect(
      resolveRetrievalProfile(env({ RETRIEVAL_GENRE: 'dialogue', SYNTHESIZE_DATE_CONTEXT: '1' }))
        .dateAnchoring,
    ).toBe('absolute');
    // Explicit legacy OFF is the measured LoCoMo pin on any genre.
    expect(resolveRetrievalProfile(env({ SYNTHESIZE_DATE_CONTEXT: '0' })).dateAnchoring).toBe(
      'none',
    );
  });

  it('legacy lane flags force always on any genre (enable-only)', () => {
    expect(
      resolveRetrievalProfile(env({ SEARCH_SEGMENT_LANE_ENABLED: '1' })).verbatimEvidence,
    ).toBe('always');
    // Their falsy state reads as unset → the genre preset applies.
    expect(
      resolveRetrievalProfile(
        env({ RETRIEVAL_GENRE: 'dialogue', SEARCH_SEGMENT_LANE_ENABLED: '0' }),
      ).verbatimEvidence,
    ).toBe('always');
  });
});

describe('genre presets — per-company overlay', () => {
  it('an overlay genre re-applies THAT genre preset for the company', () => {
    const e = env({
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        diaryco: { genre: 'dialogue' },
      }),
    });
    const p = resolveRetrievalProfileFor('diaryco', e);
    expect(p.genre).toBe('dialogue');
    expect(p.verbatimEvidence).toBe('always');
    expect(p.dateAnchoring).toBe('none');
    // The default genre's preset no longer applies to this company.
    expect(p.abstentionCalibration).toBe('off');
    expect(p.sceneTraces).toBe(false);
    // Other tenants keep the default genre + its preset.
    const other = resolveRetrievalProfileFor('other', e);
    expect(other.genre).toBe('assistant_chat');
    expect(other.abstentionCalibration).toBe('verifier');
  });

  it('an explicit env key still beats the overlay genre preset', () => {
    const e = env({
      RETRIEVAL_VERBATIM_EVIDENCE: 'off',
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        diaryco: { genre: 'dialogue' },
      }),
    });
    expect(resolveRetrievalProfileFor('diaryco', e).verbatimEvidence).toBe('off');
  });

  it('an overlay field beats the preset (and everything else)', () => {
    const e = env({
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        diaryco: { genre: 'dialogue', verbatimEvidence: 'fused' },
        chatco: { sceneTraces: false, abstentionCalibration: 'coverage' },
      }),
    });
    const diary = resolveRetrievalProfileFor('diaryco', e);
    expect(diary.verbatimEvidence).toBe('fused');
    // Untouched preset fields survive next to the overlaid one.
    expect(diary.dateAnchoring).toBe('none');
    const chat = resolveRetrievalProfileFor('chatco', e);
    expect(chat.sceneTraces).toBe(false);
    expect(chat.abstentionCalibration).toBe('coverage');
  });
});

describe('genre presets — documents axis', () => {
  it('documents has an EMPTY preset (unmeasured axis)', () => {
    expect(GENRE_PRESETS.documents).toEqual({});
  });

  it('documents resolves to pure code defaults', () => {
    const p = resolveRetrievalProfile(env({ RETRIEVAL_GENRE: 'documents' }));
    expect(p.verbatimEvidence).toBe('shape_conditioned');
    expect(p.dateAnchoring).toBe('absolute');
    expect(p.abstentionCalibration).toBe('off');
    expect(p.sceneTraces).toBe(false);
  });
});

describe('genre presets — full effective profile per genre (snapshot)', () => {
  // The full resolved profile per genre with nothing else set. Any
  // future preset edit MUST show up as a diff in exactly these
  // literals — that visibility is the point of the test.
  const CODE_DEFAULTS = {
    verbatimEvidence: 'shape_conditioned',
    insightEvidence: 'off',
    timelineEvidence: 'off',
    coverageScanMode: 'brute',
    coverageLexMode: 'phrase',
    cjkSegmentation: false,
    multilingualLaneRouting: false,
    multilingualConflict: false,
    scanHnswEf: 400,
    scanHnswOverfetch: 4,
    dateAnchoring: 'absolute',
    temporalMode: 'filter',
    factBudget: 48,
    quotesPerPrompt: 8,
    sourceExcerptsCap: 16,
    segmentTopK: 5,
    segmentRerank: false,
    factRerank: false,
    mentionDates: false,
    sceneTraces: false,
    enumStrict: false,
    extraEvidenceCap: 40,
    wideProbe: false,
    wideProbeLimit: 12,
    entityExpansion: false,
    salienceScoring: false,
    updateStoryRendering: false,
    orderingFrame: false,
    abstentionCalibration: 'off',
    verifierTopicCoverage: false,
    verifierModel: '',
    digestEvidence: false,
    digestLanes: 'all',
    rawWindow: false,
    rawWindowSpan: 2,
    assistantLane: false,
    assistantLaneTopK: 6,
    assistantLaneMatch: 'assistant',
    factsAsKeys: false,
    factsAsKeysCap: 8,
    timeFilter: false,
    dateMath: false,
    answerConditioning: false,
    noiseFilter: false,
    searchLoop: false,
    l3Escalation: false,
    l3MaxSessions: 3,
    l3TokenCap: 60000,
    abstentionMinTopScore: 0.35,
    abstentionMinEvidence: 2,
    lanes: [] as string[],
  };

  it('dialogue', () => {
    expect(wire(resolveRetrievalProfile(env({ RETRIEVAL_GENRE: 'dialogue' })))).toEqual({
      ...CODE_DEFAULTS,
      genre: 'dialogue',
      // preset: segment-lane genre law (+3.8pp LoCoMo, measured twice)
      verbatimEvidence: 'always',
      // preset: LoCoMo gold convention (date context −7.1pp; E2 pin)
      dateAnchoring: 'none',
    });
  });

  it('assistant_chat (the default genre)', () => {
    const expected = {
      ...CODE_DEFAULTS,
      genre: 'assistant_chat',
      // preset: dual-trace scene anchors (+20.2pp LongMemEval-S)
      sceneTraces: true,
      // preset: V9 verdict-decline win (+17.5pp abstention, BEAM)
      abstentionCalibration: 'verifier',
    };
    expect(wire(resolveRetrievalProfile(env({})))).toEqual(expected);
    expect(wire(resolveRetrievalProfile(env({ RETRIEVAL_GENRE: 'assistant_chat' })))).toEqual(
      expected,
    );
  });

  it('documents', () => {
    expect(wire(resolveRetrievalProfile(env({ RETRIEVAL_GENRE: 'documents' })))).toEqual({
      ...CODE_DEFAULTS,
      genre: 'documents',
    });
  });
});
