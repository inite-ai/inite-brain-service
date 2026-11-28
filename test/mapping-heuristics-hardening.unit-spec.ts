/**
 * Hostile collection names and entity types in the records mapping
 * assistant: an OpenAPI document (or a sample, or the model) names the
 * collections, so `__proto__`, `constructor` and a long run of `_` are
 * inputs, not hypotheticals (code-scanning js/polynomial-redos,
 * js/remote-property-injection).
 */
import { ConfigService } from '@nestjs/config';
import { MappingAssistantService } from '../src/source-plane/records/mapping-assistant.service';
import { entityTypeOf, isEntityType } from '../src/source-plane/records/mapping-heuristics';
import type { RecordsDoorService } from '../src/source-plane/records/records-door.service';

describe('entityTypeOf — hostile collection names', () => {
  it('trims a long run of underscores in linear time', () => {
    const hostile = `a${'_'.repeat(200_000)}b`;
    const started = performance.now();
    const type = entityTypeOf(hostile);
    expect(performance.now() - started).toBeLessThan(250);
    expect(type).toBeNull(); // far longer than an entity type may be
    expect(entityTypeOf('__tickets')).toBe('ticket');
  });

  it('never reads an alias off Object.prototype', () => {
    expect(entityTypeOf('constructor')).toBe('constructor');
    expect(entityTypeOf('toString')).toBe('tostring');
    expect(entityTypeOf('__proto__')).toBe('proto');
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(typeof entityTypeOf(name)).toBe('string');
    }
  });

  it('isEntityType refuses the prototype key', () => {
    expect(isEntityType('__proto__')).toBe(false);
    expect(isEntityType('deal')).toBe(true);
    expect(isEntityType(42)).toBe(false);
  });
});

describe('mapping assistant — a `__proto__` entity type', () => {
  it('is dropped, and the answer objects keep their prototype', async () => {
    const door = {
      vocabularyFor: async () => ({ predicates: [], entityTypes: [] }),
    } as unknown as RecordsDoorService;
    const svc = new MappingAssistantService(door, new ConfigService({}));
    // JSON.parse makes `__proto__` an OWN key, as a request body would.
    const endpoints = JSON.parse(
      '{"__proto__": {"list": {"path": "/x"}, "fields": {"id": "id", "name": "name"}, "polluted": true}}',
    ) as Record<string, never>;
    const res = await svc.assist('co', {
      packId: 'crm_memory',
      openapi: { text: JSON.stringify({ openapi: '3.0.0', paths: {} }) },
      endpoints,
    });
    expect(Object.getPrototypeOf(res.endpoints)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(res.mapping)).toBe(Object.prototype);
    expect((res.endpoints as Record<string, unknown>).polluted).toBeUndefined();
    expect(res.entities).toEqual([]);
  });
});
