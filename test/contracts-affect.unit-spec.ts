/**
 * #909: the affect / consent wire contracts parse what the services return.
 */
import {
  AffectContestResponseSchema,
  AffectEraseResponseSchema,
  AffectExportResponseSchema,
  ConsentListResponseSchema,
  ConsentRevokeResponseSchema,
} from '../src/contracts/users/affect.schema';
import type { AffectEraseResult, AffectExport } from '../src/affect/affect-plane.service';
import type { ConsentWire } from '../src/affect/consent.service';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

const fullExport: AffectExport = {
  userId: 'u1',
  facts: [
    {
      factId: 'knowledge_fact:f1',
      aspect: 'relationship__stated_affect',
      statement: 'exhausted',
      assertion: 'inferred',
      inferredBy: { recorder: 'affect-reader-v1', version: 'v1', model: 'm', modality: 'text' },
      validFrom: '2026-11-01T00:00:00.000Z',
      validUntil: '2026-11-02T00:00:00.000Z',
      retracted: false,
    },
  ],
  beliefs: [
    {
      beliefId: 'semantic_belief:b1',
      subject: 'ana',
      field: 'mood',
      statement: 'flat',
      assertion: 'inferred',
      validFrom: '2026-11-01T00:00:00.000Z',
      status: 'active',
    },
  ],
  riskSignals: [
    {
      signalId: 'risk_signal:r1',
      observedAt: '2026-11-01T10:00:00.000Z',
      level: 'concern',
      quote: 'some words',
      episodeId: 'episode:e1',
      confidence: 0.6,
    },
  ],
  observations: [
    {
      observationId: 'affect_observation:o1',
      observedAt: '2026-11-01T10:00:00.000Z',
      valence: -0.6,
      label: 'sadness',
      target: 'the weigh-in',
      quote: 'I dread the weigh-in',
      episodeId: 'episode:e1',
      confidence: 0.8,
      assertion: 'inferred',
      inferredBy: { recorder: 'affect-reader-v1', model: 'm', modality: 'text' },
    },
  ],
};

const erased: AffectEraseResult = {
  userId: 'u1',
  scope: 'inferred',
  factsDeleted: 1,
  beliefsDeleted: 2,
  derivedDeleted: 0,
  observationsDeleted: 3,
  riskSignalsDeleted: 0,
};

const consent: Required<ConsentWire> = {
  consentId: 'consent_record:c1',
  userId: 'u1',
  purpose: 'affect_inference',
  grantedBy: 'guardian',
  basis: 'explicit_consent',
  noticeVersion: 'notice-2026-11',
  grantedAt: '2026-11-01T00:00:00.000Z',
  revokedAt: '2026-11-02T00:00:00.000Z',
  active: false,
};

describe('affect contracts', () => {
  it('export parses, every field named', () => {
    expect(AffectExportResponseSchema.safeParse(fullExport).success).toBe(true);
    expectKeys(AffectExportResponseSchema.shape, { ...fullExport });
  });

  it('erase and contest parse', () => {
    expect(AffectEraseResponseSchema.safeParse(erased).success).toBe(true);
    expectKeys(AffectEraseResponseSchema.shape, { ...erased });
    expect(
      AffectContestResponseSchema.safeParse({ contested: 'knowledge_fact:f1', erased }).success,
    ).toBe(true);
  });

  it('consents parse', () => {
    expect(ConsentListResponseSchema.safeParse({ consents: [consent] }).success).toBe(true);
    expect(
      ConsentRevokeResponseSchema.safeParse({
        purpose: 'affect_inference',
        revoked: true,
        erased: { factsDeleted: 1 },
      }).success,
    ).toBe(true);
  });
});
