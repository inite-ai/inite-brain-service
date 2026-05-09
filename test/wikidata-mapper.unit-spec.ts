import {
  mapWikidataBindings,
  WIKIDATA_TEMPLATES,
  type WikidataBinding,
  type WikidataTemplate,
} from './eval/loaders/wikidata-mapper';

/**
 * Unit coverage for the Wikidata SPARQL → JsonDirectory mapper.
 * No network — bindings are stubbed in the shape Wikidata returns
 * (verified against a real query manually). The CLI fetcher wraps
 * this mapper; its network path is not unit-tested here.
 */
describe('mapWikidataBindings', () => {
  const template: WikidataTemplate = {
    directoryName: 'wd_test',
    description: 'unit-test template',
    sparql: '',
  };

  function v(value: string): WikidataBinding[string] {
    return { type: 'literal', value };
  }
  function uri(qid: string): WikidataBinding[string] {
    return { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` };
  }

  it('emits a name fact per entity from itemLabel', () => {
    const out = mapWikidataBindings(
      [
        { item: uri('Q123'), itemLabel: v('Leo Tolstoy') },
        { item: uri('Q456'), itemLabel: v('Anton Chekhov') },
      ],
      template,
    );
    expect(out.directory.entities).toHaveLength(2);
    expect(out.directory.entities[0]).toMatchObject({
      id: 'q123',
      facts: [
        expect.objectContaining({
          predicate: 'name',
          object: 'Leo Tolstoy',
        }),
      ],
    });
    expect(out.stats.uniqueEntities).toBe(2);
  });

  it('drops entities without a name and tracks them in stats', () => {
    const out = mapWikidataBindings(
      [
        { item: uri('Q1'), itemLabel: v('A') },
        { item: uri('Q2') /* no label */ },
      ],
      template,
    );
    expect(out.directory.entities).toHaveLength(1);
    expect(out.stats.uniqueEntities).toBe(2);
    expect(out.stats.skippedEntities).toBe(1);
  });

  it('emits dob trimmed to YYYY-MM-DD', () => {
    const out = mapWikidataBindings(
      [
        {
          item: uri('Q1'),
          itemLabel: v('A'),
          dob: v('1828-09-09T00:00:00Z'),
        },
      ],
      template,
    );
    const facts = out.directory.entities[0].facts;
    expect(facts).toContainEqual(
      expect.objectContaining({ predicate: 'dob', object: '1828-09-09' }),
    );
  });

  it('emits birthPlace as predicate=address with prefix', () => {
    const out = mapWikidataBindings(
      [
        {
          item: uri('Q1'),
          itemLabel: v('A'),
          birthPlaceLabel: v('Yasnaya Polyana'),
        },
      ],
      template,
    );
    const facts = out.directory.entities[0].facts;
    expect(facts).toContainEqual(
      expect.objectContaining({
        predicate: 'address',
        object: 'birthplace: Yasnaya Polyana',
      }),
    );
  });

  it('emits country and headquarters labels with their prefixes', () => {
    const out = mapWikidataBindings(
      [
        {
          item: uri('Q1'),
          itemLabel: v('Acme'),
          countryLabel: v('United States'),
          hqLabel: v('San Francisco'),
        },
      ],
      template,
    );
    const objs = out.directory.entities[0].facts.map((f) => f.object);
    expect(objs).toContain('country: United States');
    expect(objs).toContain('headquarters: San Francisco');
  });

  it('groups multiple rows per entity (cross-product expansion)', () => {
    // Wikidata returns one row per cross-product of multi-valued
    // properties. Two occupations × two genres = 4 rows for ONE entity.
    const out = mapWikidataBindings(
      [
        {
          item: uri('Q1'),
          itemLabel: v('Author A'),
          occupationLabel: v('writer'),
          genreLabel: v('novel'),
        },
        {
          item: uri('Q1'),
          itemLabel: v('Author A'),
          occupationLabel: v('writer'),
          genreLabel: v('short story'),
        },
        {
          item: uri('Q1'),
          itemLabel: v('Author A'),
          occupationLabel: v('playwright'),
          genreLabel: v('novel'),
        },
        {
          item: uri('Q1'),
          itemLabel: v('Author A'),
          occupationLabel: v('playwright'),
          genreLabel: v('short story'),
        },
      ],
      template,
    );
    expect(out.directory.entities).toHaveLength(1);
    const facts = out.directory.entities[0].facts;
    const occupations = facts.filter(
      (f) => f.predicate === 'interacted_with' && f.object.startsWith('occupation:'),
    );
    const genres = facts.filter((f) => f.predicate === 'preference');
    // Distinct dedupe → 2 occupations + 2 genres, NOT 4 of each.
    expect(occupations.map((f) => f.object).sort()).toEqual([
      'occupation: playwright',
      'occupation: writer',
    ]);
    expect(genres.map((f) => f.object).sort()).toEqual([
      'genre: novel',
      'genre: short story',
    ]);
  });

  it('emits inception trimmed and prefixed', () => {
    const out = mapWikidataBindings(
      [
        {
          item: uri('Q1'),
          itemLabel: v('Acme'),
          inception: v('1976-04-01T00:00:00Z'),
        },
      ],
      template,
    );
    const facts = out.directory.entities[0].facts;
    expect(facts).toContainEqual(
      expect.objectContaining({
        predicate: 'interacted_with',
        object: 'founded 1976-04-01',
      }),
    );
  });

  it('handles ill-formed item URIs by skipping the binding', () => {
    const out = mapWikidataBindings(
      [
        { item: { type: 'literal', value: '' }, itemLabel: v('X') },
        { item: uri('Q1'), itemLabel: v('A') },
      ],
      template,
    );
    expect(out.directory.entities).toHaveLength(1);
    expect(out.directory.entities[0].id).toBe('q1');
  });

  it('returns empty directory on empty bindings', () => {
    const out = mapWikidataBindings([], template);
    expect(out.directory.entities).toEqual([]);
    expect(out.stats.rawBindings).toBe(0);
    expect(out.stats.uniqueEntities).toBe(0);
  });

  it('preserves Cyrillic / non-ASCII labels verbatim', () => {
    const out = mapWikidataBindings(
      [
        {
          item: uri('Q5879'),
          itemLabel: v('Лев Толстой'),
          birthPlaceLabel: v('Ясная Поляна'),
        },
      ],
      template,
    );
    const facts = out.directory.entities[0].facts;
    expect(facts).toContainEqual(
      expect.objectContaining({ predicate: 'name', object: 'Лев Толстой' }),
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        predicate: 'address',
        object: 'birthplace: Ясная Поляна',
      }),
    );
  });

  it('templates: SPARQL strings declare $LIMIT placeholder', () => {
    for (const [name, t] of Object.entries(WIKIDATA_TEMPLATES)) {
      expect(t.sparql).toContain('$LIMIT');
      expect(t.directoryName).toMatch(/^[a-z0-9_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      // Non-empty name guards against typos in template registration.
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('directoryName flows through the mapper output', () => {
    const out = mapWikidataBindings(
      [{ item: uri('Q1'), itemLabel: v('A') }],
      template,
    );
    expect(out.directory.directoryName).toBe('wd_test');
    expect(out.directory.description).toBe('unit-test template');
  });

  it('lowercases Q-id for the entity ref id (Surreal record-id stability)', () => {
    const out = mapWikidataBindings(
      [{ item: uri('Q987654'), itemLabel: v('Test') }],
      template,
    );
    expect(out.directory.entities[0].id).toBe('q987654');
  });
});
