/**
 * Pack memory projections (migration 0110) — the pure seams:
 *
 *  1. packSceneVersion: the namespaced segmenterVersion `pack:<id>+<fp>`
 *     must never collide with the composer's `scene-segmenter-v1*`
 *     id-spaces, and a pack upgrade must fork a NEW world.
 *  2. validateScenes / validateStateDeltas: the declaration fence — a
 *     pack stages only what its OWN manifest memoryModel declares, with
 *     declared stateModel TRANSITIONS staying advisory (never a gate).
 */
import { BadRequestException } from '@nestjs/common';
import {
  packSceneVersion,
  PACK_SCENE_PROJECTOR,
} from '../src/documents/scene-candidate-writer.service';
import { validateScenes, validateStateDeltas } from '../src/documents/external-candidates.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import type { PackMemoryModel } from '../src/ai/domain-packs/manifest';
import type {
  SubmittedScene,
  SubmittedStateDelta,
} from '../src/documents/dto/submit-candidates.dto';

describe('packSceneVersion', () => {
  it('is pack: namespaced with an 8-hex fingerprint', () => {
    expect(packSceneVersion('realty', '1.0.0')).toMatch(/^pack:realty\+[0-9a-f]{8}$/);
  });

  it('never enters the composer namespace', () => {
    // The composer's worlds are `scene-segmenter-v1` / `scene-segmenter-v1+<fp>`;
    // the pack namespace is disjoint by prefix, so the two writers can
    // never swap or purge each other's rows.
    expect(packSceneVersion('realty', '1.0.0').startsWith(SEGMENTER_VERSION)).toBe(false);
  });

  it('is deterministic per (pack, version) and forks on a pack upgrade', () => {
    expect(packSceneVersion('realty', '1.0.0')).toBe(packSceneVersion('realty', '1.0.0'));
    expect(packSceneVersion('realty', '1.0.0')).not.toBe(packSceneVersion('realty', '1.1.0'));
    expect(packSceneVersion('realty', '1.0.0')).not.toBe(packSceneVersion('estates', '1.0.0'));
  });

  it('stays within the admin purge route input bound for the longest packId', () => {
    // DTO caps indexerId at 64 chars; `pack:` + 64 + `+` + 8 = 78 must
    // pass the (raised, 128) SEGMENTER_VERSION_MAX_CHARS bound.
    expect(packSceneVersion('p'.repeat(64), '9.9.9').length).toBeLessThanOrEqual(128);
  });

  it('pins the projector impl stamp', () => {
    expect(PACK_SCENE_PROJECTOR).toBe('pack-scene-projector-v1');
  });
});

const model: PackMemoryModel = {
  sceneSchemas: [{ id: 'viewing', description: 'A property viewing.' }],
  stateModels: [
    {
      id: 'deal',
      subjectType: 'deal',
      states: ['open', 'under_offer', 'closed'],
      // Declares ONLY open→under_offer; under_offer→closed stays
      // undeclared to prove transitions are advisory.
      transitions: [{ from: 'open', to: 'under_offer' }],
    },
  ],
};

const scene = (extra: Partial<SubmittedScene> = {}): SubmittedScene => ({
  schemaId: 'viewing',
  label: 'Viewing at 12 Elm St',
  gist: 'Client toured the property.',
  ...extra,
});

const delta = (extra: Partial<SubmittedStateDelta> = {}): SubmittedStateDelta => ({
  sceneIndex: 0,
  stateModelId: 'deal',
  subject: 'Smith purchase',
  to: 'under_offer',
  ...extra,
});

describe('validateScenes', () => {
  it('accepts a declared schema with bounded fields', () => {
    expect(() => validateScenes([scene()], model, 'realty')).not.toThrow();
  });

  it('rejects a schemaId the pack never declared (cannot-squat fence)', () => {
    expect(() => validateScenes([scene({ schemaId: 'intake' })], model, 'realty')).toThrow(
      BadRequestException,
    );
  });

  it('rejects every scene when the pack declares no sceneSchemas at all', () => {
    expect(() => validateScenes([scene()], undefined, 'realty')).toThrow(BadRequestException);
    expect(() =>
      validateScenes([scene()], { stateModels: model.stateModels ?? [] }, 'realty'),
    ).toThrow(BadRequestException);
  });

  it('rejects an over-long label and an empty gist', () => {
    expect(() => validateScenes([scene({ label: 'x'.repeat(201) })], model, 'realty')).toThrow(
      BadRequestException,
    );
    expect(() => validateScenes([scene({ gist: '   ' })], model, 'realty')).toThrow(
      BadRequestException,
    );
  });

  it('requires occurredFrom/occurredTo together, parseable, and ordered', () => {
    expect(() =>
      validateScenes([scene({ occurredFrom: '2026-09-01T10:00:00Z' })], model, 'realty'),
    ).toThrow(BadRequestException);
    expect(() =>
      validateScenes(
        [scene({ occurredFrom: 'not a date', occurredTo: '2026-09-01T11:00:00Z' })],
        model,
        'realty',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      validateScenes(
        [scene({ occurredFrom: '2026-09-01T12:00:00Z', occurredTo: '2026-09-01T11:00:00Z' })],
        model,
        'realty',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      validateScenes(
        [scene({ occurredFrom: '2026-09-01T10:00:00Z', occurredTo: '2026-09-01T11:00:00Z' })],
        model,
        'realty',
      ),
    ).not.toThrow();
  });
});

describe('validateStateDeltas', () => {
  it('accepts a declared model with declared states', () => {
    expect(() =>
      validateStateDeltas([delta()], { sceneCount: 1, model, indexerId: 'realty' }),
    ).not.toThrow();
  });

  it('declared transitions stay ADVISORY — an undeclared transition passes', () => {
    // under_offer→closed is NOT in the declared transitions; the manifest
    // contract says transitions are vocabulary, never a gate.
    expect(() =>
      validateStateDeltas([delta({ from: 'under_offer', to: 'closed' })], {
        sceneCount: 1,
        model,
        indexerId: 'realty',
      }),
    ).not.toThrow();
  });

  it('rejects undeclared states on either end', () => {
    expect(() =>
      validateStateDeltas([delta({ to: 'demolished' })], {
        sceneCount: 1,
        model,
        indexerId: 'realty',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateStateDeltas([delta({ from: 'haunted' })], {
        sceneCount: 1,
        model,
        indexerId: 'realty',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects an undeclared stateModelId and a model-less pack', () => {
    expect(() =>
      validateStateDeltas([delta({ stateModelId: 'x' })], {
        sceneCount: 1,
        model,
        indexerId: 'realty',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateStateDeltas([delta()], { sceneCount: 1, model: undefined, indexerId: 'realty' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a sceneIndex outside this submission', () => {
    expect(() =>
      validateStateDeltas([delta({ sceneIndex: 1 })], {
        sceneCount: 1,
        model,
        indexerId: 'realty',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateStateDeltas([delta()], { sceneCount: 0, model, indexerId: 'realty' }),
    ).toThrow(BadRequestException);
  });
});
