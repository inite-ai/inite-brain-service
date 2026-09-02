/**
 * validateLocator (0109): the kind × modality cross-check matrix, the
 * per-kind shape checks, the image ⇒ page-0 rule, and the unknown-kind
 * hard error (a FLEXIBLE column must never store an unvalidated shape).
 */
import { validateLocator } from '../src/evidence/locator';

const charRange = { kind: 'charRange', start: 0, end: 10 };
const pageRegion = { kind: 'pageRegion', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
const timeRange = { kind: 'timeRange', startMs: 0, endMs: 1500 };
const frameRange = { kind: 'frameRange', startFrame: 0, endFrame: 24 };
const track = { kind: 'track', trackId: 'speaker-1' };

describe('validateLocator — kind × modality matrix', () => {
  const MODALITIES = ['image', 'audio', 'video', 'document', 'sensor'] as const;
  const ALLOWED: Record<string, readonly string[]> = {
    charRange: ['document'],
    pageRegion: ['document', 'image'],
    timeRange: ['audio', 'video', 'sensor'],
    frameRange: ['video'],
    track: ['audio', 'video', 'sensor'],
  };
  const LOCATORS: Record<string, Record<string, unknown>> = {
    charRange,
    pageRegion,
    timeRange,
    frameRange,
    track,
  };

  it.each(
    Object.keys(LOCATORS).flatMap((kind) => MODALITIES.map((m) => [kind, m] as [string, string])),
  )('%s × %s follows the matrix', (kind, modality) => {
    const err = validateLocator(modality, LOCATORS[kind]!);
    if (ALLOWED[kind]!.includes(modality)) {
      expect(err).toBeNull();
    } else {
      expect(err).toMatch(/does not apply/);
    }
  });
});

describe('validateLocator — shapes and edges', () => {
  it('rejects an unknown kind', () => {
    expect(validateLocator('image', { kind: 'pixelBlob' })).toMatch(/unknown locator kind/);
    expect(validateLocator('image', {})).toMatch(/unknown locator kind/);
  });

  it('treats prototype-chain names as unknown kinds — never a thrown TypeError', () => {
    // On a record literal these resolve to INHERITED members and would
    // pass a bare truthiness guard, then crash the unknown-field walk
    // (500 instead of 400) — caller-reachable via the ingest surface.
    for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(validateLocator('document', { kind })).toMatch(/unknown locator kind/);
    }
  });

  it('rejects non-objects', () => {
    expect(validateLocator('image', null)).toMatch(/must be an object/);
    expect(validateLocator('image', [charRange])).toMatch(/must be an object/);
    expect(validateLocator('image', 'charRange')).toMatch(/must be an object/);
  });

  it('pageRegion on an image must use page 0', () => {
    expect(validateLocator('image', { ...pageRegion, page: 3 })).toMatch(/page 0/);
    expect(validateLocator('document', { ...pageRegion, page: 3 })).toBeNull();
  });

  it('rejects inverted / negative ranges', () => {
    expect(validateLocator('document', { kind: 'charRange', start: 5, end: 5 })).toMatch(
      /end > start/,
    );
    expect(validateLocator('audio', { kind: 'timeRange', startMs: -1, endMs: 10 })).toMatch(
      /startMs/,
    );
    expect(validateLocator('video', { kind: 'frameRange', startFrame: 9, endFrame: 3 })).toMatch(
      /endFrame > startFrame/,
    );
  });

  it('rejects out-of-range pageRegion coords and empty trackId', () => {
    expect(validateLocator('image', { ...pageRegion, w: 1.5 })).toMatch(/w in \[0,1\]/);
    expect(validateLocator('image', { ...pageRegion, x: 0.8, w: 0.4 })).toMatch(/x \+ w/);
    expect(validateLocator('image', { ...pageRegion, h: 0 })).toMatch(/positive w and h/);
    expect(validateLocator('audio', { kind: 'track', trackId: '' })).toMatch(/trackId/);
    expect(
      validateLocator('audio', { kind: 'track', trackId: 'speaker', startMs: 5, endMs: 4 }),
    ).toMatch(/endMs must be greater/);
  });

  it('rejects unknown fields instead of persisting shape drift in the FLEXIBLE column', () => {
    expect(validateLocator('image', { ...pageRegion, executable: 'nope' })).toMatch(
      /unknown field 'executable'/,
    );
  });
});
