/**
 * The compatibility rules behind both contract gates (the MCP schema
 * golden and the REST openapi check): what counts as breaking for a
 * client that SENDS a shape versus one that READS it, and what is mere
 * drift. Pure; see scripts/ci/schema-compat.ts.
 */
import { compareToolSchemas, jsonEqual, schemaBreaks } from '../scripts/ci/schema-compat';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

const req = (o: unknown, n: unknown) =>
  schemaBreaks({ old: o, new: n, at: 'x', direction: 'request' });
const res = (o: unknown, n: unknown) =>
  schemaBreaks({ old: o, new: n, at: 'x', direction: 'response' });

describe('schemaBreaks — request (the client sends it)', () => {
  const base = obj({ q: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] } }, ['q']);

  it('an identical schema is not breaking', () => {
    expect(req(base, base)).toEqual([]);
  });

  it('a new optional property is not breaking', () => {
    expect(req(base, obj({ ...base.properties, extra: { type: 'number' } }, ['q']))).toEqual([]);
  });

  it('a new enum value and a widened type are not breaking', () => {
    const wider = obj(
      { q: { type: ['string', 'null'] }, mode: { type: 'string', enum: ['a', 'b', 'c'] } },
      ['q'],
    );
    expect(req(base, wider)).toEqual([]);
  });

  it('dropping a requirement is not breaking', () => {
    expect(req(base, obj(base.properties))).toEqual([]);
  });

  it('a removed property is breaking', () => {
    expect(req(base, obj({ q: { type: 'string' } }, ['q']))).toEqual([
      "x: property 'mode' removed",
    ]);
  });

  it('a newly required property is breaking, new or existing', () => {
    expect(req(base, obj(base.properties, ['q', 'mode']))).toEqual([
      "x: property 'mode' is newly required",
    ]);
    expect(req(base, obj({ ...base.properties, k: { type: 'string' } }, ['q', 'k']))).toEqual([
      "x: property 'k' is newly required",
    ]);
  });

  it('a narrowed or changed type is breaking', () => {
    expect(req({ type: 'number' }, { type: 'integer' })).toEqual([
      'x: type narrowed from number to integer',
    ]);
    expect(req({ type: 'string' }, { type: 'number' })).toEqual([
      'x: type narrowed from string to number',
    ]);
    expect(req({}, { type: 'string' })).toEqual(['x: type narrowed from any to string']);
    // integer → number widens.
    expect(req({ type: 'integer' }, { type: 'number' })).toEqual([]);
  });

  it('a removed enum value is breaking, and so is a new enum on a free field', () => {
    expect(req({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] })).toEqual([
      'x: enum value "b" removed',
    ]);
    expect(req({ type: 'string' }, { type: 'string', enum: ['a'] })).toEqual([
      'x: values restricted to enum ["a"]',
    ]);
  });

  it('recurses into nested objects and array items', () => {
    const o = obj({ list: { type: 'array', items: obj({ id: { type: 'string' } }) } });
    const n = obj({ list: { type: 'array', items: obj({}) } });
    expect(req(o, n)).toEqual(["x.list[]: property 'id' removed"]);
  });

  it('reads nullable unions as their non-null branch plus null', () => {
    const o = obj({ v: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] } });
    const n = obj({ v: { anyOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }] } });
    expect(req(o, n)).toEqual(['x.v: enum value "b" removed']);
    // Making it non-nullable narrows it.
    expect(req(o, obj({ v: { type: 'string', enum: ['a', 'b'] } }))).toEqual([
      'x.v: type narrowed from null|string to string',
    ]);
  });

  it('resolves local $refs against each side and terminates on recursive schemas', () => {
    const doc = (props: Record<string, unknown>) => ({
      components: {
        schemas: {
          Node: obj({ ...props, child: { $ref: '#/components/schemas/Node' } }),
        },
      },
    });
    const oldDoc = doc({ name: { type: 'string' } });
    const newDoc = doc({});
    const breaks = schemaBreaks({
      old: { $ref: '#/components/schemas/Node' },
      new: { $ref: '#/components/schemas/Node' },
      at: 'x',
      direction: 'request',
      oldRoot: oldDoc,
      newRoot: newDoc,
    });
    expect(breaks).toEqual(["x: property 'name' removed"]);
  });
});

describe('schemaBreaks — response (the client reads it)', () => {
  const base = obj({ id: { type: 'string' }, n: { type: 'integer' } }, ['id', 'n']);

  it('a new property, a new requirement and a narrowed type are not breaking', () => {
    expect(
      res(base, obj({ ...base.properties, extra: { type: 'string' } }, ['id', 'n', 'extra'])),
    ).toEqual([]);
    expect(res(obj({ v: { type: ['string', 'null'] } }), obj({ v: { type: 'string' } }))).toEqual(
      [],
    );
  });

  it('a removed property is breaking', () => {
    expect(res(base, obj({ id: { type: 'string' } }, ['id']))).toEqual(["x: property 'n' removed"]);
  });

  it('a property no longer always present is breaking', () => {
    expect(res(base, obj(base.properties, ['id']))).toEqual([
      "x: property 'n' is no longer always present",
    ]);
  });

  it('a widened or changed type is breaking', () => {
    expect(res({ type: 'integer' }, { type: 'number' })).toEqual([
      'x: type changed from integer to number',
    ]);
    expect(res({ type: 'string' }, { type: ['string', 'null'] })).toEqual([
      'x: type changed from string to null|string',
    ]);
    expect(res({ type: 'string' }, {})).toEqual(['x: type widened from string to any']);
  });

  it('enum changes are not judged on the read side', () => {
    expect(res({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })).toEqual([]);
  });
});

describe('compareToolSchemas — the MCP golden', () => {
  const golden = {
    search: obj({ query: { type: 'string' }, limit: { type: 'integer' } }, ['query']),
    record: obj({ subject: { type: 'string' } }, ['subject']),
  };

  it('identical maps have neither breaks nor drift', () => {
    expect(compareToolSchemas(golden, structuredClone(golden))).toEqual({
      breaking: [],
      drift: [],
    });
  });

  it('a removed or renamed tool is breaking', () => {
    const live = { search: golden.search, record_fact: golden.record };
    expect(compareToolSchemas(golden, live)).toEqual({
      breaking: ["tool 'record' removed or renamed"],
      drift: ["tool 'record_fact' added"],
    });
  });

  it('a removed property, a new requirement, a narrowed type, a lost enum value are breaking', () => {
    const live = {
      search: obj({ query: { type: 'string' }, limit: { type: 'string' } }, ['query', 'limit']),
      record: obj({}, []),
    };
    expect(compareToolSchemas(golden, live).breaking).toEqual([
      'search.limit: type narrowed from integer to string',
      "search: property 'limit' is newly required",
      "record: property 'subject' removed",
    ]);
  });

  it('a new tool, a new optional property and a reworded description are drift only', () => {
    const live = {
      search: obj(
        {
          query: { type: 'string', description: 'reworded' },
          limit: { type: 'integer' },
          cursor: { type: 'string' },
        },
        ['query'],
      ),
      record: golden.record,
      new_tool: obj({}),
    };
    expect(compareToolSchemas(golden, live)).toEqual({
      breaking: [],
      drift: ["tool 'search': input schema changed (non-breaking)", "tool 'new_tool' added"],
    });
  });
});

describe('jsonEqual', () => {
  it('ignores key order, not array order', () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});
