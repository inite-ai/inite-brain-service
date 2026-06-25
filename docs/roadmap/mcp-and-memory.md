# MCP surface + memory — next session brief

> **STATUS (2026-06-25): ~95% SHIPPED — historical brief, not a TODO.**
> Phases 1–4 are all landed: `memory_diff`, `summarize_entity`,
> `get_competing_facts`, `detect_contradiction`, procedural memory, MCP
> resources (`brain://entity/...`), sampling, the new skills, and the
> ClaudeMcpAgent. The live MCP surface is **21 tools** (15 read / 20 with
> write / 21 with admin) + 2 resources. The only genuinely-open items are:
> the full paid LoCoMo run + published numbers (Phase 5.2), optional
> BERTScore (5.3), and MCP resource *subscribe* (4.2, deferred to v2). Read
> the rest as a record of what was built, not work to redo.

Self-contained brief для следующей сессии. Open this file first.

## Кто это читает

Ассистент, продолжающий работу над brain после коммита `6b54322`
("mcp: + search_multi_hop / synthesize / link_entities /
forget_entity tools"). Пользователь хочет добить MCP до SOTA уровня
и закрыть оставшиеся drift'ы.

Перед началом: `git log --oneline -10` чтобы понять что свежее
сверху. На текущий момент main = `6b54322`, 610 тестов проходят,
lint+tsc чисто, репо public AGPL-3.0.

## Контекст — что уже есть

### MCP tools (src/mcp/mcp.service.ts)

| Tool | Scope | Status |
|---|---|---|
| `search_knowledge` | read | ✓ |
| `search_multi_hop` | read | ✓ свежий |
| `synthesize` | read | ✓ свежий |
| `get_entity_profile` | read | ✓ |
| `get_entity_timeline` | read | ✓ |
| `find_related_entities` | read | ✓ |
| `record_fact` | write | ✓ |
| `retract_fact` | write | ✓ |
| `link_entities` | write | ✓ свежий |
| `forget_entity` | admin | ✓ свежий |

### Skills (skills/brain-*/SKILL.md) — bundle v0.2.0

- `brain-search` — обновлён, упоминает новые tools
- `brain-recall` — НЕ обновлён, упоминает только profile/timeline/related
- `brain-bitemporal` — НЕ обновлён, не знает про multi-hop asOf
- `brain-mcp-setup` — Claude Desktop / Cursor / Goose only

### LoCoMo infra (test/eval/locomo/, scripts/run-locomo.ts)

- HttpAgent baseline ✓ (deterministic, без Anthropic-ключа)
- ClaudeMcpAgent НЕ реализован (нужен Anthropic SDK + MCP transport)
- Full run НЕ запускался (~$80 на gpt-4o-mini)

## Phase 1 — новые MCP tools (SOTA territory)

Все четыре уверенно ленднутся за одну сессию. Берётся тот же
паттерн что в `6b54322` — три helper'а `registerReadTools` /
`registerWriteTools` / `registerAdminTools`. Каждый новый tool в
свою группу.

### 1.1 `get_competing_facts` (brain:read)

**Что:** list facts в `COMPETING` статусе для одной entity.

**Зачем:** agent-resolution конфликтов — рынковый growing pattern,
Letta / MemGPT / Mem0 этого не делают. Brain уже имеет COMPETING
status (см. `src/facts/conflict-resolver.service.ts`), но из MCP
агенту до них не достучаться.

**Где сервис:** проверить `FactsService.listCompeting(companyId,
entityId)`. Если нет — добавить (это SQL: `SELECT * FROM
knowledge_fact WHERE entityId = $eid AND status = 'competing'`).

**Schema:**
```ts
inputSchema: {
  entityId: z.string(),
  predicate: z.string().optional(), // filter to one predicate
  asOf: z.string().datetime().optional(),
}
```

**Acceptance:** unit-тест в стиле mcp-tools.unit-spec.ts +
интеграционный smoke который показывает что 2 facts с разным
object'ом в одном predicate возвращаются как competing pair.

### 1.2 `summarize_entity` (brain:read)

**Что:** one-liner про entity для LLM-context. ~100 токенов max.

**Зачем:** агент сейчас собирает это руками из profile + timeline
+ get_competing — лишние round-trips. Один tool возвращает уже
сжатый текст.

**Стратегия:** есть `CompactionService.summarize()` уже работает в
dreams loop — переиспользуем. Либо сделать inline-LLM call с
template'ом "Summarize this entity in one sentence: name=X,
top_facts=[...]".

**Schema:**
```ts
inputSchema: {
  entityId: z.string(),
  asOf: z.string().datetime().optional(),
  styleHint: z.enum(['neutral', 'sales', 'support']).optional(),
}
output: { entityId: string, summary: string, factsConsidered: number }
```

**Gotcha:** LLM call inside MCP tool = дорого. Кэшировать в
`compacted_entity` table per (entityId, asOf hash, styleHint).
LRU 500 entries; invalidate on fact ingest.

### 1.3 `memory_diff` (brain:read) — **killer feature**

**Что:** diff между двумя `asOf` точками. Returns: created /
retracted / changed facts + new entities + deprecated entities
between time A and B.

**Зачем:** "What changed since last conversation?" — этого ещё
никто не сделал нормально. Mem0 даёт incremental updates но не
explicit diff. Это будет публикуемая фича в README.

**Where:** новый `MemoryDiffService` в `src/diff/`. Запрос — два
`asOf` cursor'а; сервис делает один SurrealDB query с UNION ALL
по двум bitemporal cursor'ам, JS-стороне сравнивает.

**Schema:**
```ts
inputSchema: {
  from: z.string().datetime(),
  to: z.string().datetime(),
  entityIds: z.array(z.string()).optional(), // scope to a set
  predicates: z.array(z.string()).optional(),
}
output: {
  createdFacts: FactRef[],
  retractedFacts: FactRef[],
  changedFacts: { factId, before, after }[],
  newEntities: EntityRef[],
  forgottenEntities: { entityIdHash, reason }[],
}
```

**Gotcha:** retractedAt < to AND retractedAt >= from — это есть в
audit_event table (migration 0023). Diff читает оттуда, а не из
knowledge_fact (там некоторые retract'ы могли уже compactnut'ься).

**Acceptance:** test/memory-diff.e2e — спавнит brain, ingest 5
facts в момент T1, retract 1 + add 1 в T2, diff(T1, T2) показывает
1 retract + 1 add.

### 1.4 `detect_contradiction` (brain:read, preflight check)

**Что:** "Если я сейчас insertну такой fact, противоречит ли он
тому что есть?" Dry-run версия conflict resolver'а.

**Зачем:** агент решает ингестить или нет до того как тратить
ингест-токены + перед record_fact видит explain.

**Стратегия:** существующий `ConflictResolverService` уже умеет
explain — выставить его в read-only mode и обернуть в MCP tool.

**Schema:**
```ts
inputSchema: {
  entityRef: { vertical, id } | { entityId },
  predicate: z.string(),
  object: z.string(),
  validFrom: z.string().datetime(),
  confidence: z.number().min(0).max(1).optional(),
}
output: {
  wouldOutcome: 'INSERTED' | 'SUPERSEDED' | 'COMPETING' | 'REJECTED',
  reasoning: string,
  opposingFacts: FactRef[],
}
```

**Acceptance:** unit-тест с mock'нутым ConflictResolverService.

## Phase 2 — Skills sweep

### 2.1 `brain-recall/SKILL.md` update

Сейчас skill учит дёргать profile+timeline+related. Добавить:

- Когда вместо этого использовать `search_multi_hop` (если entity
  ID неизвестен, и agent ищет паттерн через несколько entities)
- Когда `summarize_entity` (если нужен briefing вместо raw facts)
- Когда `get_competing_facts` (если timeline показывает conflict
  и хочется adjudicate)

### 2.2 `brain-bitemporal/SKILL.md` update

Расширить:

- `asOf` в `search_multi_hop` (тот же семантика, planner получает
  cursor)
- `memory_diff` — главный новый use case для bitemporal. Показать
  пример "что мы узнали за неделю".
- Pattern "when did we first learn X?" → `get_entity_timeline`
  читать `recordedAt` (не `validFrom`).

### 2.3 `brain-write/SKILL.md` — НОВЫЙ skill

Сейчас нет. Учит:

- Когда использовать record_fact vs link_entities
- Как выставлять confidence (0.5 = LLM extraction, 0.9 = explicit
  user statement, 1.0 = system observation)
- Preflight через `detect_contradiction` перед записью
- identity_of cycle guard rejecting self-merge
- retract vs forget — когда что (retract = "no longer believed",
  forget = "must be deleted, GDPR")

### 2.4 `brain-conflict/SKILL.md` — НОВЫЙ skill

Сейчас нет. Учит:

- Что значит COMPETING status
- get_competing_facts → human-in-the-loop verdict → record_fact
  с supersedes hint
- Когда LLM может сам разрешить (dreams resolver делает это
  автоматически за определёнными threshold'ами)

### 2.5 `brain-mcp-setup/SKILL.md` update

Сейчас Claude Desktop / Cursor / Goose. Добавить:

- Aider (`aider --mcp brain.inite.ai/mcp/<tenant>`)
- Block Goose v2 (manifest update)
- Continue.dev (config.yaml mcp section)
- n8n MCP-trigger node
- Raw `@modelcontextprotocol/sdk` example (если кто-то пишет
  custom client)

### 2.6 Bundle bump

`skills/VERSION` 0.2.0 → 0.3.0 (minor: новые skills + новый tool
references). CHANGELOG entry.

## Phase 3 — Plumbing drift

### 3.1 Embedding model adapter hints

Сейчас MCP `search_*` ничего не говорит про какой embedder
используется. Добавить в description hint: "this tenant uses
bge-m3 (1024d, multilingual)" или "openai-text-embedding-3-small
(1536d)". Источник — `EmbedderService.cacheStats().provider`.

Куда впихнуть — описание tool'а на этапе registerTool. Динамически
читать из `embedder.cacheStats()` на каждый buildServer call.

### 3.2 SSE streaming для тяжелых tools

`search_multi_hop` с synthesize может занимать 5-15s. Mcp Server
SDK поддерживает progress notifications — пинговать `hop 1/3
done`, `hop 2/3 done`, `synthesize generating`.

Где смотреть: `@modelcontextprotocol/sdk` examples + текущая SSE
реализация в `/v1/admin/jobs/stream` для шаблона.

### 3.3 MCP transport health endpoint

Сейчас `GET /mcp/:companyId` без auth даёт ошибку, не дружелюбную
для setup'а. Добавить `GET /mcp/:companyId/health` — без auth,
возвращает {ok, version, tools[]}.

## Phase 4 — SOTA уровень

### 4.1 Procedural memory

**Что:** третий тип memory data — "how to" patterns которые
trigger'ятся в подходящий момент. Mem0 v2 paper про это есть.

**Пример:** "When user asks about pricing, mention they're on
platinum tier — they get 20% off". Это не fact (нет subject /
predicate / object), и не episode (не привязано к timestamp).

**Дизайн:**
- New table `procedural_memory` per tenant
- Fields: trigger (text or embedding), action (text), priority,
  decayHalfLife
- MCP tools: `record_procedure`, `match_procedure` (against
  current context), `list_procedures`
- Integration с search_multi_hop — после retrieval pass'а
  matched procedures приклеиваются к synthesize prompt

**Acceptance:** scenario где запись procedure → search_multi_hop
с matching context → синтез включает procedure-guided text.

### 4.2 MCP resources (mcp://entity/<id>)

**Что:** MCP spec позволяет server'у expose'ить resources с
subscribe semantics. Brain мог бы:
- `mcp://entity/<id>` — full profile, subscribable
- `mcp://entity/<id>/timeline` — timeline cursor, streams new
  facts as ingested
- `mcp://changefeed/<since>` — global changefeed for the tenant

**Зачем:** агент может подписаться на entity и получать push'ы
вместо poll'а. Никто из competition этого не делает.

**Where:** `@modelcontextprotocol/sdk` имеет `server.resource()`.
Реализация — wrap existing changefeed service.

**Gotcha:** Streamable HTTP transport ограничивает subscribe'ы по
сравнению с stdio. Прочитать spec прежде чем закладывать.

### 4.3 Sampling capability

**Что:** MCP позволяет server'у запросить у клиента LLM call.
Brain мог бы:
- `synthesize` отправляет verifier prompt на client side ("Claude,
  ты сейчас оцени answerability вот по этим фактам")
- Self-hosted operator не платит за brain's OpenAI bill — все LLM
  calls на client side

**Зачем:** AGPL self-hosting + не хочется заставлять operator'а
держать OpenAI key для verifier'а. Sampling = сервер просит
клиента "позови твою модель".

**Where:** `server.sample(prompt, options)` в SDK. Реализация в
synthesize service — fallback path "если client supports sampling,
use it; иначе — local OpenAI".

**Gotcha:** Sampling capability negotiation — клиент должен
объявить что поддерживает. Aider / Claude Desktop / Cursor пока
не все умеют. Feature-detect и fallback.

## Phase 5 — LoCoMo

### 5.1 ClaudeMcpAgent

**Что:** второй QaAgent в `test/eval/locomo/claude-agent.ts`.
Использует Anthropic SDK + MCP transport. То что репортится в
publications.

**Шаги:**
- Add `@anthropic-ai/sdk` dep (если не стоит)
- Spawn MCP transport на test brain process
- Claude calls с MCP server registered
- Один tool call loop per QA question, max 6 turns

**Где смотреть:** Anthropic docs про MCP integration в SDK.

### 5.2 Full run + публикация

С Phase 1-4 в проде запустить full LoCoMo на 10 sample × ~1500 QA:

```bash
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  tsx scripts/run-locomo.ts \
    --dataset /tmp/locomo10.json \
    --agent claude-mcp \
    --out var/locomo-published.json
```

Бюджет: ~$80 OpenAI (extraction + brain LLM calls) + ~$30
Anthropic (Claude через MCP). Wall clock 2-4h.

Опубликовать:
- `var/locomo-published.json` → docs/locomo-baseline.md
- README "Latest gate run" → добавить LoCoMo row
- Blog post "How brain compares to Mem0 / Zep / MemGPT on LoCoMo"

### 5.3 BERTScore (optional)

Если есть GPU доступ — добавить BERTScore поверх предсказаний из
`var/locomo-published.json`. Post-hoc, не в основной pipeline.

## Phase 6 — Repo hygiene

### 6.1 Migration verify

В этой ветке появилось `src/db/migrations/0034_supersede_no_retracted_at_fix.surql`
от параллельной сессии. Проверить что migration работает + есть
тест на инвариант. Файл `test/migration-resolver-invariants.unit-spec.ts`
уже untracked в репо — поймать его в git.

### 6.2 Параллельные изменения в job-claim / embedder / calibration

В рабочей копии остались untracked / unstaged изменения от других
сессий:
- `src/jobs/job-claim.service.ts`
- `src/ai/embedder.service.ts`
- `src/ai/embedder/bge-m3-embedder.provider.ts`
- `src/ai/calibration/calibration-refit.service.ts`
- куча test/* модификаций

Все они уже на `main` в коммитах между моими — `git log
--oneline` покажет. Проверить что моя working copy синхронизирована.

## Acceptance bar (стандартный для каждой phase)

- `pnpm test` — все existing + new зелёные
- `pnpm lint` — exit 0
- `pnpm exec tsc --noEmit` — exit 0
- Каждый новый MCP tool → unit-тест в `test/mcp-tools.unit-spec.ts`
- Каждая новая DB-touching фича → real-e2e тест
- Skills bundle bump (если skills тронуты) → CHANGELOG entry

## Gotchas / lessons learned из предыдущих сессий

1. **`buildServer()` rapidly hits max-lines-per-function (200).**
   Split по scope в helper'ы — `registerReadTools` /
   `registerWriteTools` / `registerAdminTools`. Шаблон в текущем
   `src/mcp/mcp.service.ts`.

2. **Tenancy:** один API key = одна companyId. Никаких per-call
   tenant overrides. Если нужно — отдельный admin key.

3. **MCP SDK `_registeredTools` поле приватно**, но это
   единственный способ протестировать tool registration без
   spawn'а HTTP-сервера. Cast через `as unknown as` — OK для
   тестов, в production коде не использовать.

4. **`/v1/ingest/mention` shape — `text + contextRef + emittedAt
   + knownEntities`**, не `entityRef + validFrom + source`. См.
   `src/ingest/dto/ingest-mention.dto.ts`. Старая fact-style
   форма даёт HTTP 400.

5. **`/v1/entities/:id/forget` requires `brain:admin`**, не
   `brain:write`. См. `src/entities/entities.controller.ts:71`.

6. **`ForgetEntityDto.reason` — enum**, не free-text. Принимает
   только `gdpr_request` / `tenant_offboarding` / `operator_request`.

7. **Параллельные сессии часто бывают** — `git pull` в начале и
   `git log --oneline -5` чтобы понять что свежее сверху main.

8. **README sticks out как landing page** — все детали в `docs/*.md`.
   Не разворачивай README обратно в мегадок.

## Подсказки по приоритетам

Если время ограничено и нужно выбрать — порядок ценности:

1. **memory_diff** (1.3) — killer feature, реально SOTA, никто не
   сделал; публикуемая фича
2. **get_competing_facts** (1.1) — закрывает growing pattern
   agent-resolution; быстро ленднется
3. **MCP resources** (4.2) — отличает brain от competition на
   уровне MCP capability; в спеке но никто не использует
4. **brain-write skill** (2.3) — отсутствие задокументированного
   write-path путь = barrier to entry для агент-builder'ов
5. **ClaudeMcpAgent + full LoCoMo run** (5.1 + 5.2) — публикуемая
   метрика vs Mem0/Zep/MemGPT
6. **summarize_entity** (1.2) — quality-of-life
7. **detect_contradiction** (1.4) — power-user
8. **procedural memory** (4.1) — большой проект, отдельная фаза

## Файлы которые читать первыми

- `src/mcp/mcp.service.ts` — текущий MCP surface
- `src/mcp/mcp.module.ts` — DI
- `src/ingest/dto/*.ts` — все wire shapes
- `src/multi-hop/multi-hop.service.ts` + dto
- `src/synthesize/synthesize.service.ts` + dto
- `test/mcp-tools.unit-spec.ts` — шаблон тестов
- `skills/brain-search/SKILL.md` — шаблон skill'а
- `docs/locomo.md` — текущее состояние LoCoMo

Если что — у пользователя auto memory с pointer'ом на этот файл.
