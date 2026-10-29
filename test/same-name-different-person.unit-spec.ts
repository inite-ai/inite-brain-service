/**
 * Two different people who share a name stay two entities (#815) — and one
 * person mentioned twice still stays one.
 *
 * The naming ladder's deterministic rungs (exact canonical name / alias,
 * identical transliterated key) used to reuse the first entity carrying the
 * mention's name before anything looked at a fact. "Anna Schmidt", a vet in
 * Munich, and "Anna Schmidt", a software engineer at Orbital in Lisbon, were
 * fused on the second mention, and the dreams dedup — which looks for PAIRS
 * — could never see it afterwards.
 *
 * These tests run the REAL ladder (EntityUpsertService) and the REAL
 * resolver (EntityResolverService) over an in-memory entity table; only the
 * judge's LLM call is stubbed, with verdicts of the shape the judge returns
 * for these inputs (a contradiction on city/profession/employer is
 * "different", consistent or unrelated facts are "same").
 */
import { EntityJudgeService } from '../src/ai/entity-judge.service';
import { nameKey } from '../src/common/name-key';
import { EntityResolverService } from '../src/ingest/entity-resolver.service';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';

interface Row {
  id: string;
  canonicalName: string;
  aliases: string[];
  nameKeys: string[];
  userId?: string;
  facts: string[];
}

/** A tenant DB that answers the ladder's statements over `rows`. */
function fakeDb(rows: Row[]) {
  let seq = 0;
  const visible = (r: Row) => r.userId === undefined;
  const pick = (r: Row) => ({ id: r.id, canonicalName: r.canonicalName });
  const query = jest.fn(
    async (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
      if (sql.includes('canonicalNameLc = $name')) {
        const name = String(params.name);
        const raw = String(params.rawName);
        return [
          rows
            .filter(
              (r) =>
                visible(r) && (r.canonicalName.toLowerCase() === name || r.aliases.includes(raw)),
            )
            .map(pick),
        ];
      }
      if (sql.includes('nameKeys CONTAINS $key')) {
        return [
          rows.filter((r) => visible(r) && r.nameKeys.includes(String(params.key))).map(pick),
        ];
      }
      if (sql.startsWith('CREATE')) {
        const d = params.d as { canonicalName: string; aliases: string[]; nameKeys: string[] };
        const row: Row = {
          id: `knowledge_entity:new${++seq}`,
          canonicalName: d.canonicalName,
          aliases: d.aliases,
          nameKeys: d.nameKeys,
          facts: [],
        };
        rows.push(row);
        return [[{ id: row.id }]];
      }
      // Key stamps, the candidate scans of step 3 (misses here), anything else.
      return [[]];
    },
  );
  return { query, rows };
}

/**
 * A judge with a realistic verdict: different when the two sides place the
 * person in different cities or professions, same otherwise. The facts it
 * reads come from the in-memory rows, as `fetchTopFacts` would render them.
 */
function stubJudge(rows: Row[]) {
  const CLUES = ['Munich', 'Lisbon', 'vet', 'software engineer'];
  const clues = (text: string) => CLUES.filter((c) => text.includes(c));
  const judge = jest.fn(async (existing: string, incoming: string) => {
    const a = clues(existing);
    const b = clues(incoming);
    if (a.length === 0 || b.length === 0) return 'same';
    return a.some((c) => b.includes(c)) ? 'same' : 'different';
  });
  const fetchTopFacts = jest.fn(async (_db: unknown, id: string) => {
    const facts = rows.find((r) => r.id === id)?.facts ?? [];
    return facts.length > 0 ? facts.map((f) => `- ${f}`).join('\n') : '(no facts)';
  });
  return {
    isAvailable: () => true,
    judge,
    fetchTopFacts,
  } as unknown as EntityJudgeService & { judge: jest.Mock; fetchTopFacts: jest.Mock };
}

function makeLadder(rows: Row[], cfg: Record<string, string> = {}) {
  const config = {
    get: (k: string, d?: string) =>
      k in cfg ? cfg[k] : k === 'INGEST_INLINE_RESOLUTION_ENABLED' ? '1' : d,
  } as never;
  const embedder = { embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as never;
  const judge = stubJudge(rows);
  const resolver = new EntityResolverService(config, embedder, judge);
  const upsert = new EntityUpsertService(resolver);
  const db = fakeDb(rows);
  const steps: string[] = [];
  const resolve = (name: string, incomingFacts: string[], type = 'staff') =>
    upsert.resolveOrCreateNamedEntity({
      db: db as never,
      e: { name, type },
      hint: undefined,
      _contextRef: { vertical: 'chat' },
      incomingFacts,
      onStep: (s) => steps.push(s),
    });
  return { resolve, judge, db, steps };
}

const vet = (): Row => ({
  id: 'knowledge_entity:vet',
  canonicalName: 'Anna Schmidt',
  aliases: ['Anna Schmidt'],
  nameKeys: [nameKey('Anna Schmidt')],
  facts: ['occupation: vet', 'runs: small animal clinic', 'located_in: Munich'],
});

const ENGINEER_FACTS = ['employer: Orbital', 'role: software engineer', 'lives_in: Lisbon'];

describe('same name, different person (#815)', () => {
  it('a mention whose facts contradict the same-named entity mints a new entity', async () => {
    const rows = [vet()];
    const { resolve, judge, steps } = makeLadder(rows);
    const id = await resolve('Anna Schmidt', ENGINEER_FACTS);
    expect(id).not.toBe('knowledge_entity:vet');
    expect(steps).toEqual(['created']);
    expect(rows).toHaveLength(2);
    // The judge was asked about the exact-name candidate with both names
    // and told the names are identical — the hint that asks only whether
    // the facts contradict.
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(judge.judge.mock.calls[0]![2]).toMatchObject({
      similarity: 'same-name',
      names: { a: 'Anna Schmidt', b: 'Anna Schmidt' },
    });
  });

  it('the same person mentioned again with consistent facts is still reused', async () => {
    const rows = [vet()];
    const { resolve, steps } = makeLadder(rows);
    expect(await resolve('Anna Schmidt', ['works_in: Munich', 'treats: our dog'])).toBe(
      'knowledge_entity:vet',
    );
    expect(steps).toEqual(['exact']);
    expect(rows).toHaveLength(1);
  });

  it('a mention with no facts is reused without a judge call — nothing to contradict', async () => {
    const rows = [vet()];
    const { resolve, judge, steps } = makeLadder(rows);
    expect(await resolve('Anna Schmidt', [])).toBe('knowledge_entity:vet');
    expect(steps).toEqual(['exact']);
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('a candidate with no facts is reused without a judge call', async () => {
    const rows = [{ ...vet(), facts: [] }];
    const { resolve, judge } = makeLadder(rows);
    expect(await resolve('Anna Schmidt', ENGINEER_FACTS)).toBe('knowledge_entity:vet');
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('an "unsure" verdict keeps the reuse the ladder always made', async () => {
    const rows = [vet()];
    const { resolve, judge } = makeLadder(rows);
    judge.judge.mockResolvedValue('unsure');
    expect(await resolve('Anna Schmidt', ENGINEER_FACTS)).toBe('knowledge_entity:vet');
  });

  // Cyrillic and Latin spellings that fold to one key ("ivan petrov").
  const ivan = (): Row => ({
    id: 'knowledge_entity:ivan',
    canonicalName: 'Ivan Petrov',
    aliases: ['Ivan Petrov'],
    nameKeys: [nameKey('Ivan Petrov')],
    facts: ['occupation: vet', 'located_in: Munich'],
  });

  it('a transliterated spelling of the same person still merges through the key', async () => {
    const rows = [ivan()];
    const { resolve, steps } = makeLadder(rows);
    expect(nameKey('Иван Петров')).toBe(nameKey('Ivan Petrov'));
    expect(await resolve('Иван Петров', ['профессия: vet', 'город: Munich'])).toBe(
      'knowledge_entity:ivan',
    );
    expect(steps).toEqual(['translit']);
  });

  it('a transliterated spelling that contradicts the entity is someone else', async () => {
    const rows = [ivan()];
    const { resolve, steps } = makeLadder(rows);
    const id = await resolve('Иван Петров', ENGINEER_FACTS);
    expect(id).not.toBe('knowledge_entity:ivan');
    expect(steps).toEqual(['created']);
  });

  it('once both exist, a later mention lands on the one its facts fit', async () => {
    const rows = [vet()];
    const { resolve } = makeLadder(rows);
    const engineer = await resolve('Anna Schmidt', ENGINEER_FACTS);
    rows.find((r) => r.id === engineer)!.facts.push(...ENGINEER_FACTS);
    // Lisbon engineer again — not the vet, and not a third Anna.
    expect(await resolve('Anna Schmidt', ['writes: Rust', 'role: software engineer'])).toBe(
      engineer,
    );
    // The vet again.
    expect(await resolve('Anna Schmidt', ['occupation: vet'])).toBe('knowledge_entity:vet');
    expect(rows).toHaveLength(2);
  });

  it('a shorter name of a known person still reaches the judge and merges', async () => {
    // "Anna" after "Anna Schmidt" misses every exact rung and is found by
    // the resolver's name-part scan — the contradiction guard must not
    // stand in its way.
    const rows = [vet()];
    const { resolve, db, steps } = makeLadder(rows);
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('string::starts_with($k, $pre)')) {
        return [
          [
            {
              entityId: 'knowledge_entity:vet',
              canonicalName: 'Anna Schmidt',
              nameKeys: ['anna schmidt'],
            },
          ],
        ];
      }
      return [[]];
    });
    expect(await resolve('Anna', ['treats: our dog'])).toBe('knowledge_entity:vet');
    expect(steps).toEqual(['judge']);
  });

  it('with inline resolution off the exact rung reuses as it always did', async () => {
    const rows = [vet()];
    const { resolve, judge } = makeLadder(rows, { INGEST_INLINE_RESOLUTION_ENABLED: '0' });
    expect(await resolve('Anna Schmidt', ENGINEER_FACTS)).toBe('knowledge_entity:vet');
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('a personal entity of the same name is never a candidate (scope fence kept)', async () => {
    const rows = [{ ...vet(), userId: 'u1' }];
    const { resolve, db, judge } = makeLadder(rows);
    const id = await resolve('Anna Schmidt', ['occupation: vet']);
    expect(id).not.toBe('knowledge_entity:vet');
    expect(judge.fetchTopFacts).not.toHaveBeenCalledWith(expect.anything(), 'knowledge_entity:vet');
    const ladderSql = db.query.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('canonicalNameLc = $name') || s.includes('nameKeys CONTAINS $key'));
    expect(ladderSql.length).toBeGreaterThan(0);
    for (const sql of ladderSql) expect(sql).toContain('userId IS NONE');
  });
});

describe('EntityResolverService.confirmSameName', () => {
  function make(verdicts: string[], facts = '- occupation: vet') {
    const config = {
      get: (k: string, d?: string) => (k === 'INGEST_INLINE_RESOLUTION_ENABLED' ? '1' : d),
    } as never;
    const judge = {
      isAvailable: () => true,
      fetchTopFacts: jest.fn().mockResolvedValue(facts),
      judge: jest.fn(),
    };
    for (const v of verdicts) judge.judge.mockResolvedValueOnce(v);
    const svc = new EntityResolverService(config, { embed: jest.fn() } as never, judge as never);
    return { svc, judge };
  }
  const C = [{ entityId: 'knowledge_entity:a' }, { entityId: 'knowledge_entity:b' }];
  const call = (svc: EntityResolverService) =>
    svc.confirmSameName({
      db: {} as never,
      name: 'Anna Schmidt',
      candidates: C,
      incomingFacts: ['role: software engineer'],
    });

  it('prefers a later "same" over an earlier "unsure"', async () => {
    const { svc } = make(['unsure', 'same']);
    expect(await call(svc)).toEqual({ kind: 'reuse', entityId: 'knowledge_entity:b' });
  });

  it('skips a "different" candidate for the next one', async () => {
    const { svc } = make(['different', 'unsure']);
    expect(await call(svc)).toEqual({ kind: 'reuse', entityId: 'knowledge_entity:b' });
  });

  it('stops at the first "same" — no call for the rest', async () => {
    const { svc, judge } = make(['same', 'same']);
    expect(await call(svc)).toEqual({ kind: 'reuse', entityId: 'knowledge_entity:a' });
    expect(judge.judge).toHaveBeenCalledTimes(1);
  });

  it('is distinct only when every candidate is contradicted', async () => {
    const { svc } = make(['different', 'different']);
    expect(await call(svc)).toEqual({ kind: 'distinct' });
  });

  it('a failing fact read counts as nothing to contradict (never throws)', async () => {
    const { svc, judge } = make([]);
    judge.fetchTopFacts.mockRejectedValue(new Error('surreal down'));
    expect(await call(svc)).toEqual({ kind: 'reuse', entityId: 'knowledge_entity:a' });
    expect(judge.judge).not.toHaveBeenCalled();
  });
});

describe('EntityJudgeService — the same-name hint', () => {
  it('tells the judge the names are identical and asks only for a contradiction', async () => {
    const config = {
      get: (k: string, d?: string) => (k === 'OPENAI_API_KEY' ? 'sk-test' : d),
    } as never;
    const svc = new EntityJudgeService(config);
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ verdict: 'different' }) } }],
    });
    (svc as unknown as { openai: unknown }).openai = { chat: { completions: { create } } };
    expect(
      await svc.judge('- located_in: Munich', '- lives_in: Lisbon', {
        cosine: 1,
        similarity: 'same-name',
        names: { a: 'Anna Schmidt', b: 'Anna Schmidt' },
      }),
    ).toBe('different');
    const prompt = JSON.stringify(create.mock.calls[0][0].messages);
    expect(prompt).toContain('The two names are identical');
    expect(prompt).toContain('A shared name alone is not identity');
    expect(prompt).not.toContain('Cosine name-similarity');
  });
});
