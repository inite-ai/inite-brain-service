/**
 * The core entity types (src/common/entity-types.ts, migration 0195): one
 * list, read by the schema ASSERT, the extractor, the records door and the
 * wire contract — and an entity keeps the type it was extracted with
 * (`typeRaw`) whenever the core type had to differ from it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import {
  ENTITY_TYPE_GLOSS,
  ENTITY_TYPES,
  PERSON_ENTITY_TYPES,
  classifyEntityType,
  entityTypeFields,
  normalizeEntityType,
} from '../src/common/entity-types';
import { EntityMappingSchema } from '../src/contracts/source-plane/source-plane.schema';
import { parseEntities } from '../src/ai/extractor-internals/grounding';
import { mapNerTypeToEntityType } from '../src/ai/extractor-internals/local-synth';
import {
  EXTRACTION_PROMPT_HEADER,
  EXTRACTION_PROMPT_HEADER_DIALOGUE,
} from '../src/ai/extractor-internals/prompts';
import { ENTITY_TYPE_VOCABULARY } from '../src/ai/extractor-internals/types';
import { mergeCandidates } from '../src/documents/candidate-merge';
import type { CandidateRow } from '../src/documents/candidate-store.service';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';
import { coreTypeOf } from '../src/source-plane/records/record-mapping';

const MIGRATIONS = join(__dirname, '../src/db/migrations');

/** The list the LAST migration that defines knowledge_entity.type asserts. */
function assertedEntityTypes(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.+\.surql$/.test(f))
    .sort();
  let last: string[] = [];
  const re =
    /DEFINE FIELD (?:IF NOT EXISTS |OVERWRITE )?type\s+ON knowledge_entity TYPE string\s+ASSERT \$value INSIDE \[([^\]]*)\]/g;
  for (const f of files) {
    for (const m of readFileSync(join(MIGRATIONS, f), 'utf8').matchAll(re)) {
      last = m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    }
  }
  return last;
}

describe('core entity types — one source of truth', () => {
  it('the schema ASSERT is exactly the TS list', () => {
    expect(assertedEntityTypes()).toEqual([...ENTITY_TYPES]);
  });

  it('adds person, organization and document, keeps every CRM-era type', () => {
    for (const t of ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other']) {
      expect(ENTITY_TYPES).toContain(t);
    }
    for (const t of ['person', 'organization', 'document']) expect(ENTITY_TYPES).toContain(t);
  });

  it('the extractor enum IS the list, and both prompts gloss every type', () => {
    expect(ENTITY_TYPE_VOCABULARY).toBe(ENTITY_TYPES);
    for (const t of ENTITY_TYPES) {
      const line = `${t} — ${ENTITY_TYPE_GLOSS[t]}`;
      expect(EXTRACTION_PROMPT_HEADER).toContain(line);
      expect(EXTRACTION_PROMPT_HEADER_DIALOGUE).toContain(line);
    }
  });

  it('the records contract coreType enum is the list (additive)', () => {
    const coreType = EntityMappingSchema.shape.coreType.unwrap();
    expect(coreType.options).toEqual([...ENTITY_TYPES]);
    for (const t of ENTITY_TYPES) {
      expect(EntityMappingSchema.safeParse({ fields: {}, coreType: t }).success).toBe(true);
    }
    expect(EntityMappingSchema.safeParse({ fields: {}, coreType: 'vendor' }).success).toBe(false);
  });

  it('person is person-shaped for the fact resolver; organization is not', () => {
    expect([...PERSON_ENTITY_TYPES].sort()).toEqual(['customer', 'person', 'staff']);
  });
});

describe('classifyEntityType / normalizeEntityType', () => {
  it('a core type passes through with no typeRaw', () => {
    for (const t of ENTITY_TYPES) expect(classifyEntityType(t)).toEqual({ type: t });
  });

  it('an unknown type folds to other and keeps what was written', () => {
    expect(classifyEntityType('vendor')).toEqual({ type: 'other', typeRaw: 'vendor' });
    expect(normalizeEntityType('vendor')).toBe('other');
  });

  it('case folds onto the core type and the original is kept; padding is not a difference', () => {
    expect(classifyEntityType('Person')).toEqual({ type: 'person', typeRaw: 'Person' });
    expect(classifyEntityType(' organization ')).toEqual({ type: 'organization' });
  });

  it('nothing written is other with no typeRaw', () => {
    for (const t of [undefined, null, 42, '', '   ']) {
      expect(classifyEntityType(t)).toEqual({ type: 'other' });
    }
  });

  it('typeRaw is a label, capped at 64 characters', () => {
    const long = 'x'.repeat(200);
    expect(classifyEntityType(long).typeRaw).toHaveLength(64);
  });
});

describe('entityTypeFields — what an entity is created with', () => {
  it('no typeRaw key when the type is a core one', () => {
    expect(entityTypeFields('person')).toEqual({ type: 'person' });
    expect(Object.keys(entityTypeFields('staff'))).toEqual(['type']);
  });

  it('an upstream typeRaw wins over the already-normalised type', () => {
    expect(entityTypeFields('other', 'vendor')).toEqual({ type: 'other', typeRaw: 'vendor' });
  });

  it('without an upstream typeRaw the written value is kept when it is not core', () => {
    expect(entityTypeFields('supplier')).toEqual({ type: 'other', typeRaw: 'supplier' });
  });
});

describe('the extractor keeps the raw type', () => {
  it('parseEntities sets typeRaw only when it normalised', () => {
    const parsed = parseEntities({
      entities: [
        { name: 'Ana', type: 'person' },
        { name: 'Acme', type: 'company' },
      ],
    });
    expect(parsed[0]).toMatchObject({ type: 'person' });
    expect(parsed[0]).not.toHaveProperty('typeRaw');
    expect(parsed[1]).toMatchObject({ type: 'other', typeRaw: 'company' });
  });

  it('local NER: ORG is an organization now; PER keeps staff', () => {
    expect(mapNerTypeToEntityType('ORG')).toBe('organization');
    expect(mapNerTypeToEntityType('PER')).toBe('staff');
    expect(mapNerTypeToEntityType('LOC')).toBe('location');
  });

  it('CRM records keep filing people and organisations as customers', () => {
    expect(coreTypeOf('person')).toBe('customer');
    expect(coreTypeOf('organization')).toBe('customer');
    expect(coreTypeOf('owner')).toBe('staff');
  });
});

describe('the candidate pipeline carries typeRaw to the commit', () => {
  it('mergeCandidates keeps the first typeRaw of a merged entity', () => {
    const entity = (id: string, payload: Record<string, unknown>): CandidateRow => ({
      id,
      runId: 'indexer_run:r1',
      chunkSeq: 0,
      kind: 'entity',
      confidence: 0.5,
      status: 'pending',
      payload: { entityIndex: 0, indexerId: '_general', ...payload },
    });
    const merged = mergeCandidates([
      entity('candidate:a', { name: 'Acme', type: 'other' }),
      entity('candidate:b', { name: 'acme', type: 'other', typeRaw: 'vendor' }),
      entity('candidate:c', { name: 'Ana', type: 'person' }),
    ]);
    const acme = merged.entities.find((e) => e.name === 'Acme');
    expect(acme?.typeRaw).toBe('vendor');
    expect(merged.entities.find((e) => e.name === 'Ana')).not.toHaveProperty('typeRaw');
  });
});

describe('EntityUpsertService writes typeRaw on create', () => {
  function capture() {
    const created: Array<Record<string, unknown>> = [];
    const query = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
      if (sql.startsWith('CREATE')) {
        created.push(params.d as Record<string, unknown>);
        return [[{ id: `knowledge_entity:n${created.length}` }]];
      }
      return [[]];
    });
    return { db: { query } as unknown as Surreal, created };
  }

  const create = async (e: { name: string; type: string; typeRaw?: string }) => {
    const { db, created } = capture();
    await new EntityUpsertService().resolveOrCreateNamedEntity({
      db,
      e,
      hint: undefined,
      _contextRef: { vertical: 'chat' },
    });
    return created[0]!;
  };

  it('a folded extraction keeps its original type', async () => {
    const row = await create({ name: 'Ana', type: 'other', typeRaw: 'sister' });
    expect(row).toMatchObject({ type: 'other', typeRaw: 'sister' });
  });

  it('an unknown type written straight to the upsert is folded and kept', async () => {
    const row = await create({ name: 'Globex', type: 'vendor' });
    expect(row).toMatchObject({ type: 'other', typeRaw: 'vendor' });
  });

  it('a core type writes no typeRaw', async () => {
    const row = await create({ name: 'Maria', type: 'person' });
    expect(row.type).toBe('person');
    expect(row).not.toHaveProperty('typeRaw');
  });
});
