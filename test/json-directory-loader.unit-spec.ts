import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadDirectoryJson,
  parseDirectoryObject,
} from './eval/loaders/json-directory.loader';

/**
 * Loader unit coverage. Exercises the parser shape + error messages
 * + steps emitted to the eval runner. Disk-IO branch covered by
 * one round-trip case; everything else uses parseDirectoryObject so
 * the suite stays fast.
 */
describe('json-directory loader', () => {
  it('parses a minimal valid directory', () => {
    const out = parseDirectoryObject({
      directoryName: 'mini',
      entities: [
        {
          id: 'a',
          facts: [
            {
              predicate: 'name',
              object: 'A',
              validFrom: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
    });
    expect(out.scenario.id).toBe('directory.mini');
    expect(out.scenario.setup).toHaveLength(1);
    expect(out.scenario.setup[0]).toMatchObject({
      kind: 'fact',
      predicate: 'name',
      object: 'A',
      entityRef: { vertical: 'mini', id: 'a' },
    });
    expect(out.stats).toEqual({
      entities: 1,
      facts: 1,
      retracts: 0,
      forgets: 0,
    });
  });

  it('inlines a per-entity retract referencing a tag', () => {
    const out = parseDirectoryObject({
      directoryName: 'd',
      entities: [
        {
          id: 'a',
          facts: [
            {
              predicate: 'complained_about',
              object: 'broken thing',
              validFrom: '2026-03-01T00:00:00Z',
              tag: 'a-c1',
            },
          ],
          retract: [{ tag: 'a-c1', reason: 'walked back' }],
        },
      ],
    });
    expect(out.scenario.setup).toHaveLength(2);
    expect(out.scenario.setup[1]).toMatchObject({
      kind: 'retract',
      tag: 'a-c1',
      reason: 'walked back',
    });
    expect(out.stats.retracts).toBe(1);
  });

  it('emits forget steps after all entity facts', () => {
    const out = parseDirectoryObject({
      directoryName: 'd',
      entities: [
        {
          id: 'a',
          facts: [
            {
              predicate: 'name',
              object: 'A',
              validFrom: '2026-01-01T00:00:00Z',
            },
          ],
        },
        {
          id: 'b',
          facts: [
            {
              predicate: 'name',
              object: 'B',
              validFrom: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
      forgetEntities: [
        { ref: 'a', reason: 'gdpr_request', requestId: 'GDPR-1' },
      ],
    });
    // Expect: fact-a, fact-b, forget-a (forget AFTER all facts so
    // cascade has the full footprint).
    expect(out.scenario.setup).toHaveLength(3);
    expect(out.scenario.setup[2]).toMatchObject({
      kind: 'forget',
      entityRef: { vertical: 'd', id: 'a' },
      reason: 'gdpr_request',
      requestId: 'GDPR-1',
    });
    expect(out.stats.forgets).toBe(1);
  });

  it('honours an explicit vertical override on a forget ref', () => {
    const out = parseDirectoryObject({
      directoryName: 'd',
      entities: [
        {
          id: 'a',
          vertical: 'override',
          facts: [
            {
              predicate: 'name',
              object: 'A',
              validFrom: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
      forgetEntities: [
        {
          ref: 'override.a',
          reason: 'gdpr_request',
          requestId: 'GDPR-1',
        },
      ],
    });
    expect(out.scenario.setup[1]).toMatchObject({
      kind: 'forget',
      entityRef: { vertical: 'override', id: 'a' },
    });
  });

  it('rejects a top-level non-object', () => {
    expect(() => parseDirectoryObject(42)).toThrow(/top-level must be an object/);
    expect(() => parseDirectoryObject(null)).toThrow(/top-level must be an object/);
  });

  it('rejects a missing directoryName', () => {
    expect(() =>
      parseDirectoryObject({ entities: [{ id: 'a', facts: [] }] }),
    ).toThrow(/missing required 'directoryName'/);
  });

  it('rejects an empty entities array with a clear message', () => {
    expect(() =>
      parseDirectoryObject({ directoryName: 'd', entities: [] }),
    ).toThrow(/zero entities/);
  });

  it('rejects an entity with zero facts', () => {
    expect(() =>
      parseDirectoryObject({
        directoryName: 'd',
        entities: [{ id: 'a', facts: [] }],
      }),
    ).toThrow(/zero facts/);
  });

  it('rejects a duplicate tag on the same entity', () => {
    expect(() =>
      parseDirectoryObject({
        directoryName: 'd',
        entities: [
          {
            id: 'a',
            facts: [
              {
                predicate: 'p',
                object: 'o1',
                validFrom: '2026-01-01T00:00:00Z',
                tag: 'dup',
              },
              {
                predicate: 'p',
                object: 'o2',
                validFrom: '2026-01-01T00:00:00Z',
                tag: 'dup',
              },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate tag 'dup'/);
  });

  it('rejects a retract referencing a non-existent tag', () => {
    expect(() =>
      parseDirectoryObject({
        directoryName: 'd',
        entities: [
          {
            id: 'a',
            facts: [
              {
                predicate: 'p',
                object: 'o',
                validFrom: '2026-01-01T00:00:00Z',
              },
            ],
            retract: [{ tag: 'nope', reason: 'r' }],
          },
        ],
      }),
    ).toThrow(/tag 'nope' references no fact/);
  });

  it('rejects a forget with an invalid reason enum', () => {
    expect(() =>
      parseDirectoryObject({
        directoryName: 'd',
        entities: [
          {
            id: 'a',
            facts: [
              {
                predicate: 'p',
                object: 'o',
                validFrom: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ],
        forgetEntities: [
          { ref: 'a', reason: 'bogus', requestId: 'r' },
        ],
      }),
    ).toThrow(/reason must be one of/);
  });

  it('rejects a non-string id with type-aware message', () => {
    expect(() =>
      parseDirectoryObject({
        directoryName: 'd',
        entities: [
          {
            id: 42,
            facts: [
              {
                predicate: 'p',
                object: 'o',
                validFrom: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ],
      }),
    ).toThrow(/id must be a string, got number/);
  });

  it('round-trips through the disk path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-loader-'));
    const path = join(dir, 'fixture.json');
    writeFileSync(
      path,
      JSON.stringify({
        directoryName: 'disk',
        entities: [
          {
            id: 'a',
            facts: [
              {
                predicate: 'name',
                object: 'A',
                validFrom: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ],
      }),
    );
    try {
      const out = loadDirectoryJson(path);
      expect(out.scenario.id).toBe('directory.disk');
      expect(out.stats.facts).toBe(1);
    } finally {
      unlinkSync(path);
    }
  });

  it('reports the source path on a missing-file error', () => {
    expect(() => loadDirectoryJson('/no/such/path.json')).toThrow(
      /cannot read '\/no\/such\/path\.json'/,
    );
  });

  it('reports the source path on an invalid-JSON error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-loader-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not json');
    try {
      expect(() => loadDirectoryJson(path)).toThrow(/not valid JSON/);
    } finally {
      unlinkSync(path);
    }
  });
});
