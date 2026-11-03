/**
 * #892 against a real database: a fact or a turn is found by an inflected
 * form of its word, in its own language (0184). The unstemmed indexes are
 * unchanged, so without a query language the inflected form misses, as
 * before.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import { StemBackfillService } from '../src/admin/stem-backfill.service';
import { runLexicalLeg } from '../src/search/internals/legs';
import { buildLexMatchLeg } from '../src/search/internals/lex-leg';

const AT = new Date('2026-10-01T00:00:00Z');
const quiet = { warn: () => {} };
const noFilter = { sql: '', params: {} };

describe('language stems (0184)', () => {
  let f: AppFixture;
  let surreal: SurrealService;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_stems_e2e' });
    surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE knowledge_entity:stem_e CONTENT { type: 'customer', canonicalName: 'Мария Петрова', createdAt: $at }`,
        { at: AT },
      );
      const facts = [
        { id: 'ru', object: 'подписала контракты с поставщиком', lang: 'ru' },
        { id: 'pt', object: 'assinou os contratos ontem', lang: 'pt' },
        { id: 'en', object: 'signed the contracts', lang: 'en' },
        { id: 'zh', object: '我们签了合同', lang: 'zh' },
      ];
      for (const fact of facts) {
        await db.query(
          `CREATE type::record('knowledge_fact', $id) CONTENT {
             entityId: knowledge_entity:stem_e, predicate: 'did', object: $object, lang: $lang,
             confidence: 0.9, validFrom: $at, recordedAt: $at, status: 'active', source: {}
           }`,
          { ...fact, at: AT },
        );
      }
      await db.query(
        `CREATE episode:stem_turn CONTENT {
           kind: 'turn', messageId: 'm1', conversationId: 'c1', speaker: 'user',
           text: 'Вчера встретил Марией Петровой на конференции', lang: 'ru',
           occurredAt: $at, source: {}
         }`,
        { at: AT },
      );
    });
  });

  afterAll(async () => {
    await f?.close();
  });

  const lexical = (query: string, stemLang?: string) =>
    surreal.withCompany(f.companyId, (db) =>
      runLexicalLeg({ db, logger: quiet, query, k: 10, baseWhere: noFilter, stemLang }),
    );
  const ids = (rows: Array<{ id: unknown }>) => rows.map((r) => String(r.id)).sort();

  it('a fact is found by another inflection of its word, in its language', async () => {
    expect(ids(await lexical('контрактами', 'ru'))).toContain('knowledge_fact:ru');
    expect(ids(await lexical('contrato', 'pt'))).toContain('knowledge_fact:pt');
    expect(ids(await lexical('contract', 'en'))).toContain('knowledge_fact:en');
    expect(ids(await lexical('合同', 'zh'))).toContain('knowledge_fact:zh');
  });

  it("without a query language the tenant's own language stems the query", async () => {
    // The tenant's only turn is Russian (fn::tenant_lang).
    expect(ids(await lexical('контрактами'))).toContain('knowledge_fact:ru');
  });

  it('a turn is found by the nominative of a name it inflects', async () => {
    const rows = await f.app.get(EpisodeReadStoreService).searchText({
      companyId: f.companyId,
      query: 'Мария Петрова',
      limit: 5,
      includePii: true,
      lex: buildLexMatchLeg({
        fields: ['text'],
        topic: 'Мария Петрова',
        mode: 'or_terms',
        stem: { field: 'textStem', lang: 'ru' },
      }),
    });
    expect(rows.map((r) => String(r.id))).toContain('episode:stem_turn');
  });

  it('the backfill runs and leaves nothing unstemmed', async () => {
    const result = await f.app.get(StemBackfillService).run(f.companyId);
    expect(result.remaining).toEqual({ knowledge_fact: 0, episode: 0 });
  });
});
