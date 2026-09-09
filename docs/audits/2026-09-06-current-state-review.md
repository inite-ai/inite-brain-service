# Аудит Brain: состояние на 6 сентября 2026

> **Статус на 2026-09-09.** Закрыто в main: F1 → #467 (`SliceTable` больше не экспортируется из route-модуля; сборка landing зелёная), F2 → #527, F4 → #532, F5 → #528, F8/F9 → #533. В работе (открытые PR): F3/F7 (answer-cache dependencies + порядок usage-телеметрии), F6/F10 + атомарность belief revision (доп. замечание 1). Класс FLEXIBLE-дрейфа (не в этом отчёте, найден позже): #513 (`job_run`) + #526 (все 43 объявления; механизм — экспортер SurrealDB 2.6.5 `--v3` теряет `FLEXIBLE` у `option<object>`). F11 — контракт `asOf` зафиксирован в `docs/bitemporal-semantics.md` (этот же PR). Файлы `audit-review-repros.*.txt` и `brain-audit-*.log.txt` рядом — воспроизведения и логи, на которые ссылается текст.

Проект существенно вырос по возможностям и по качеству отдельных защит. Но готовность подсистем по отдельности заметно опережает согласованность системы в целом. Наиболее опасные оставшиеся ошибки находятся на переходах: факт → feedback, факты → summary, факт + belief → кэш, сцены → текущее состояние, installed pack → разрешение raw-доступа.

## Что именно проверено

- Исходный локальный HEAD при начале работы: `b29eaec`, 26 августа. Рабочее дерево было чистым.
- Основной зафиксированный предмет аудита: `1acce24`, 6 сентября, отдельный checkout `/private/tmp/brain-audit-current`.
- Между ними: 71 commit, 391 изменённый файл, 56 275 добавленных и 3 308 удалённых строк. Это размер diff, а не оценка полезности или качества.
- Дополнительно просмотрены последующие изменения до `e072a61`: entity aliases, article normalization, slot canonicalization, ослабление cosine gate для точного single-active slot, confidence gate языкового фильтра. Файлы с основными находками ниже этими шестью commit не исправлены.
- Историческая точка сравнения: `docs/roadmap/engine-architecture-audit-2026-08.md` и последующие исправления. Старые уже закрытые проблемы не перечисляются как новые.
- Проверены критические цепочки backend, migrations, auth/user scope, provenance, scenes/beliefs, outcomes, compaction/promotion, retrieval/synthesis/cache, BFF, CI и сборка веб-приложения.
- Не проводились визуальный обход всех экранов, аудит работающего production-сервера, нагрузочное испытание и новые платные quality-eval с настоящими генераторами. Не подтверждалось, какой image и набор flags фактически работает в production: выводы о включении относятся к deployment recipe в репозитории.

Исходный каталог во время аудита обновлялся другим процессом. Первый e2e-прогон в нём стал несопоставимым: новые исходники начали требовать `compromise`, которого не было в прежнем окружении зависимостей. Его массовые ошибки компиляции **не считаются регрессией продукта**. Все итоговые проверки ниже выполнены в изолированном checkout с зависимостями его lockfile.

## Проверки

| Проверка | Результат |
| --- | --- |
| Backend typecheck | Успешно |
| Backend lint:ci | Успешно |
| Backend build | Успешно |
| Штатные unit | 355 suites / 3 949 tests, успешно |
| Штатные in-process e2e, реальная SurrealDB 3.2.4, stubs моделей | 128 suites / 619 tests, успешно |
| Socket | 6 suites / 106 tests, успешно |
| Дополнительные audit e2e | 4 воспроизведения, подтверждены |
| Дополнительные audit unit | 3 воспроизведения, подтверждены |
| Frontend vitest | 7 files / 38 tests, успешно |
| Frontend lint | 0 errors, **54 warnings** |
| Frontend production build | **Не прошла**: настоящий TypeScript route-export blocker после обхода ограничений Turbopack |

Изначально Turbopack не смог загрузить Google Fonts из песочницы; повторный запуск упёрся в запрет служебного порта. Проверка через `pnpm build --webpack` прошла компиляцию до проверки типов и выявила реальный дефект F1. Сетевые и sandbox-ошибки отдельно отнесены к среде.

Дополнительные audit-тесты специально утверждают **наблюдаемое неправильное поведение**, поэтому их зелёный статус подтверждает воспроизведение ошибки, а не исправность продукта. Копии сохранены рядом с отчётом как `.txt`, чтобы не включать диагностические проверки дефектов в штатный CI.

## Подтверждённые проблемы

### F1 — P1: frontend не собирается в production

**Место:** `brain-landing/app/[lang]/admin/scenarios/page.tsx:268`; `.github/workflows/ci.yml:124`.

Страница экспортирует `export function SliceTable`. Генерируемая Next.js проверка route-модуля отклоняет этот произвольный именованный export:

```text
Property 'SliceTable' is incompatible with index signature.
Type '... => Element | null' is not assignable to type 'never'.
```

**Доказательство:** реальная `pnpm build --webpack`, не предположение по lint. Это shared route-type validation, а не только особенность Webpack.

**Почему пропустили:** основной CI job запускает frontend lint и vitest, но не frontend production build. Отдельный deployment workflow собирает image, однако он обнаруживает проблему позже.

**Исправление:** сделать компонент локальным либо вынести в отдельный component-файл; добавить production build frontend в PR CI. Не отключать проверку типов. Экспорт существовал раньше, поэтому дата обновления зависимостей сама по себе не доказывает, что именно обновление внесло ошибку.

### F2 — P1: пользователь может оценивать чужие скрытые факты

**Место:** `src/feedback/feedback.service.ts:70`; `src/feedback/feedback.controller.ts:18`.

Feedback использует root `withCompany` и проверяет только существование fact id. Нет того user/policy fence, который используется при чтении факта. Наличие `brain:write` не означает право изменять сигналы доверия для личной памяти другого пользователя.

**Воспроизведение на реальной БД:** создать факт с `userId=alice`; ключом, привязанным к `bob`, запросить факт — **404**; тем же ключом отправить `incorrect` в `/v1/feedback` — **201**.

**Последствие:** при знании id можно влиять на чужую память и репутацию её источника; расхождение 404/201 также подтверждает существование записи. Это нарушение внутри tenant, не обнаруженная межтенантная утечка.

**Исправление:** перед feedback применять единый набор проверок видимости и разрешений на запись, включая pinned user, policy и grants по применимому контракту. Добавить REST/MCP тесты с чужим, скрытым и policy-restricted фактом.

### F3 — P1: кэш теряет зависимости смешанного ответа

**Место:** `src/answer-cache/answer-cache.service.ts:326`, запись на `:365`, проверка при чтении на `:569`.

Admission запрещает только ответы без fact citations. Ответ с одним фактом и одним belief/episode/fragment проходит. В кэш записываются полный текст ответа и только `citedFactIds`; ссылки на остальные основания ответа теряются.

**Доказательство:** unit-воспроизведение подтверждает UPSERT смешанного fact+belief ответа без `semantic_belief:old` в сохранённых зависимостях. По read-path кэш валидирует факты, а не revision belief.

**Сценарий:** факт «работает в Acme» остаётся верным, belief «живёт в A» сменился на «живёт в B». Закэшированный смешанный ответ всё ещё проходит проверку по факту работодателя. Аналогичная проблема возможна после удаления или изменения другого evidence, если связанные fact rows остаются валидными. Отдельный end-to-end сценарий выдачи после удаления evidence в этом аудите не запускался.

**Исправление:** краткосрочно запретить admission любого ответа с неподдерживаемыми evidence-зависимостями; затем хранить типизированные dependencies с revision/version и проверять все основания ответа при чтении. Один только запрет belief-only ответов недостаточен.

### F4 — P1: promotion делает активную память невидимой

**Место:** `src/compaction/promotion-runner.service.ts:354`; `src/search/internals/where-builder.ts:228`.

Summary получает `validUntil: last.validUntil ?? last.validFrom`, а исходные факты становятся `compacted` и теряют embeddings. Для обычной группы старых бессрочных событий summary сразу имеет срок действия в прошлом. Default search отбрасывает и её, и compacted originals.

**Воспроизведение на реальной БД:** пять старых `said` facts → `factsPromoted=5` → пять compacted originals, одна active summary с прошедшим `validUntil` → **ноль записей под фильтрами actual-now**.

**Статус:** ошибка старого механизма, значимость повышается тем, что deployment recipe теперь явно включает `COMPACTION_PROMOTION_ENABLED=1`.

**Исправление:** разделить временной диапазон пересказываемых событий и срок актуальности semantic summary; сводка, заменяющая актуальную память, должна оставаться доступной. Создание replacement и закрытие originals выполнять атомарно. Проверять после promotion публичный поиск, а не только `status='active'` и наличие embedding в таблице.

### F5 — P1: удалённый pack продолжает давать согласие на raw-доступ

**Место:** `src/evidence/evidence-read.service.ts:239`; `src/admin/domain-pack-install.service.ts:637`.

`consentingManifest()` читает все `domain_pack` без `status='active'`. Uninstall ставит `status='removed'`, но сохраняет manifest и accepted modality checksum. Такой pack продолжает удовлетворять raw-evidence consent gate.

**Воспроизведение на реальной БД:** install pack с `rawEvidence.serve=true` и `acceptModalities=true`; штатный uninstall; вызов используемого raw-read gate всё ещё возвращает manifest удалённого pack.

**Граница доказательства:** проверен именно consent gate после реального install/uninstall. Полная выдача blob в этом дополнительном тесте не запускалась; остальные права и grant-проверки сами по себе сохраняются.

**Исправление:** принимать consent только активных установок; согласовать uninstall с отзывом разрешений и добавить end-to-end запрет нового raw-read/raw-url после uninstall. Уже выданные capability tokens имеют отдельно оговорённую TTL-семантику — это другой контракт.

### F6 — P1: запоздалый belief может отменить более свежее подтверждение

**Место:** `src/admin/belief-promotion.service.ts:824`, stale guard ниже в том же методе.

Подтверждение того же значения обновляет provenance/counters, но не сохраняет watermark последнего свидетельства для сравнения с будущими входящими данными. Stale guard сравнивает отличающееся значение только с первоначальным `validFrom` текущей revision.

**Воспроизведение на реальной БД, targeted promotion по conversation:** A от 1 января; снова A от 1 марта; затем с задержкой поступает B от 1 февраля. Активным становится **B**, хотя последнее свидетельство — мартовское A.

**Исправление:** хранить отдельно начало действия состояния и watermark обработанных свидетельств; при targeted/incremental обработке пересчитывать affected key по полной временной цепочке. Не подменять `validFrom` временем последнего подтверждения, иначе потеряется истинное начало состояния. Добавить перестановочные тесты: конечное состояние должно зависеть от событий, а не от порядка ingest/run.

### F7 — P2: outcome фиксирует использование до окончательного решения о выдаче

**Место:** `src/synthesize/synthesize.service.ts:748`, затем integrity gate на `:769` и final verdict на `:773`.

`emitAnswerUse` и `emitBeliefAnswerUse` запускаются раньше финальных integrity/capability/grounding gates. Следовательно, предварительно supported ответ может уже увеличить `verifiedUseCount`, хотя следующий gate откажет в выдаче. Для отклонённого ответа также успевает записаться `used_in_answer`.

**Доказательство:** статически подтверждённый порядок вызовов; отдельное инструментированное воспроизведение этого пункта не запускалось.

**Последствие:** telemetry перестаёт точно означать реально выданный и принятый ответ. Когда эти counters используются в verified-use ranking/decay, ошибка становится частью поведения поиска, а не только отчётности.

**Исправление:** разделить events «верификатор поддержал draft» и «ответ реально выдан»; usage для serving эмитить после всех gates, по final result. Проверять rejected integrity/capability paths и cache hits.

### F8 — P2: параллельный feedback одного автора удваивает rollup

**Место:** `src/feedback/feedback.service.ts:85`, `:91`, `:107`.

Предыдущий verdict читается отдельно от записи нового и вычисления signed delta. Два одновременных запроса одного actor оба могут увидеть отсутствие прежнего голоса. UNIQUE оставляет одну запись feedback, а два разных запроса добавляют по `+1 confirmedCount`.

**Доказательство:** детерминированное unit-воспроизведение с барьером между concurrent reads: один actor, одна пара fact/actor, суммарный `confirmedCount += 2`. Это воспроизведение service race на mock DB; отдельный real-DB concurrency stress не выполнялся.

Новая транзакционность `memory_outcome` не закрывает этот случай: она защищает применение уже рассчитанного события от replay, но два запроса имеют разные ids и оба рассчитали неверный delta.

**Исправление:** previous vote, replacement и delta/outbox должны иметь одну атомарную границу; сверять rollup с таблицей standing votes. Нужны гонки helpful/helpful и helpful/incorrect, а не только последовательная замена.

### F9 — P2: touch возвращает suspended tenant в active roster

**Место:** `src/auth/tenant-registry.service.ts:174`.

`touch()` безусловно выполняет `activeCache.add(companyId)` ещё до throttle/DB write. Сохранённый `status='suspended'` не превращается в active в БД, но синхронный список для fan-out становится неверным до refresh — и снова после следующего touch.

**Доказательство:** unit: `register(..., suspended)` → пустой active roster → `touch()` → tenant снова в списке.

**Последствие:** suspended tenant может участвовать в background sweeps; это не доказательство обхода криптографической проверки ключа или полного tenant-wide auth bypass.

**Исправление:** отделить lastSeen от active membership, хранить известный status, не разрешать touch отменять suspension даже временно. Проверить suspended tenant с продолжающим действовать credential и несколько pods.

### F10 — P2: corroboration floor считает разные уровни одного источника как независимые

**Место:** `src/compaction/promotion-runner.service.ts:265`.

Код объединяет `episodeIds` и `conversationId` в один Set. Одна реплика `episode:e1` из `conv:c1` уже даёт размер 2; пять реплик одной conversation — до 6. Это противоречит пояснению непосредственно над кодом: «пять фактов из одного разговора — один свидетель».

**Условие:** `promotionMinEpisodes > 0`; по умолчанию этот floor выключен.

**Доказательство:** прямой разбор алгоритма, отдельный DB repro не запускался.

**Исправление:** выбрать один уровень независимости: conversation/source context; использовать episode id только как fallback, когда контекст неизвестен. Добавить тест с несколькими episodes одной conversation и одним episode с обеими ссылками.

### F11 — P2: инструкция агентам неверно описывает asOf

**Место:** `AGENTS.md:86`, `:147` против `src/search/internals/where-builder.ts:198` и `docs/bitemporal-semantics.md:26`.

AGENTS утверждает, что `asOf` — исключительно knowledge/belief time, а ожидать valid-time фильтрацию неправильно. Реальный search намеренно фильтрует `validFrom/validUntil` и специально **не ограничивает recordedAt**: поздно узнанный факт может попадать в исторический запрос.

**Последствие:** агенту предписано неверно трактовать историю. Вопросы «что было верно тогда?» и «что система знала тогда?» могут получать разные ответы; смешивать эти оси нельзя.

**Исправление:** зафиксировать контракт каждого API и привести AGENTS/MCP descriptions/docs к нему; если нужен knowledge-time snapshot, дать отдельный однозначный параметр/режим и тесты с поздно поступившим backdated fact. Не переименовывать текущее поведение вслепую: оно уже закреплено потребителями.

## Дополнительные замечания

1. **Belief revision не атомарна.** `upsertBelief()` читает active head, создаёт N+1 через `INSERT IGNORE`, затем отдельными запросами закрывает старую запись и пишет provenance. Одновременные runs могут выбрать одинаковый номер для разных значений, а crash оставляет две active revisions до следующей попытки. Это подтверждённая структура кода, но real-DB crash/race repro в данном аудите не проводился. Нужны CAS/transaction по ключу и проверка фактически вставленной revision, а не доверие `INSERT IGNORE`.
2. **Backlink re-run не умеет убирать stale pointers.** `scene-backlink.service.ts:141` делает только `array::union`. Обещание в комментариях, что re-run исправит ссылки после GDPR/purge, не соответствует этому алгоритму. Нужен reconcile для конкретного version/generation; исторические links и актуальные links должны иметь различимую семантику.
3. **L3 fallback неполон для segment/temporal-only anchors.** Эти probes возвращают conversation/time, но не наполняют `episodeById`. Если полная conversation превышает token cap, `assembleContext()` берёт window centers только из `episodeById` и может получить пустой fallback. Передавать центры как общую структуру для всех anchor sources; проверить комбинацию no fact/direct anchors + long conversation. Статическое замечание, отдельного исполнения не было.
4. **Успех batch-операции и полнота результата размыты.** В ряде новых pass ошибки превращаются в warn/skip, post-pass не влияет на общий результат compose. Нужен явный terminal status `complete/degraded/failed`, failed keys и возможность retry только неудавшихся units. Лог полезен, но не заменяет статус операции.
5. **Frontend warning debt реален, но не равен 54 багам.** Есть ref access во время render, setState-in-effect и предупреждения совместимости memoization. Разобрать по пользовательским эффектам, начиная с графа и больших списков; дальше фиксировать ratchet, не запрещать все предупреждения одним изменением.
6. **Новые эвристики стоит ограничивать доменом.** Code aliases, article normalization, duration→status mapping помогают конкретным наблюдаемым промахам, но не являются общим решением entity/ontology resolution. Требуются negative fixtures, неоднозначные имена, несколько проектов и альтернативные формулировки; mappings логичнее объявлять там, где известен домен.

## Что нравится по сравнению с прошлым

- Удаление стало существенно серьёзнее: atomic entity erase, повторяемость по requestId, удаление L0/segments/scenes/beliefs и document-derived остатков. Это реальная работа с жизненным циклом, а не косметическое улучшение API.
- Закрыт прежний fail-open риск смешанных пользовательских derived rows: есть `userIds` и отдельные проверки; новый belief serving не смешивает личную память в unscoped ответ.
- Происхождение стало цепочкой: raw evidence, scenes, typed support graph, recursive closure, отдельные citations. Такое представление легче проверять и отлаживать.
- Сцены получили fingerprinted versions; enrichment отделён от deterministic результата. Лучше прежней перезаписи одного поля и одного version name.
- Changefeed drain и outcome writes получили транзакционность и детерминированную идентичность. Исправления SurrealDB planner-no-op закреплены проверками.
- Появились tenant registry и tenant-specific overrides: сервис меньше зависит от статических dev keys и глобального deployment config.
- Стали лучше конкретные пользовательские сценарии проверки: memory-fitness, state transitions, code-memory и domain-pack batteries; отдельно тестируются неизвестные сведения и provenance. Это ценнее одного усреднённого benchmark score.
- Native ONNX вынесен из обычных in-process e2e через test doubles; вся актуальная штатная suite прошла. Но этот прогон не доказывает корректность native model lifecycle и качество настоящего генератора.
- В последующих diff языковой фильтр перестал исключать записи на основании слабого определения языка; неоднозначности alias resolution явно обрабатываются. Направление правильное, хотя флаговое включение и исторические данные требуют отдельной проверки.

Unit coverage по числу проверок выросло с 304 suites / 2 956 tests в начальном checkout до 355 / 3 949 в зафиксированной свежей версии. Это измеренное расширение тестовой базы, **не измеренный прирост memory accuracy**.

## Что не нравится архитектурно

**Слишком много независимых переключателей для зависимых гарантий.** Deployment recipe включает сразу scenes, beliefs, outcomes, integrity, fragment lane, promotion и adaptive механизмы. Наличие флага и зелёных flag-local тестов ещё не подтверждает корректность всех включённых комбинаций. Нужны несколько поддерживаемых tenant profiles с contract tests, а не обязательная поддержка любой комбинации всех knobs.

**Исправления инвариантов остаются opt-in.** Транзакционность, сохранение scopes, корректность зависимости cache и отсутствие потери памяти — это свойства продукта. После миграции и проверки совместимости такие гарантии не должны зависеть от того, вспомнил ли оператор включить очередной flag.

**Provenance graph пока не стал общим механизмом invalidation.** Разные писатели и удалятели всё ещё знают собственные наборы dependent tables, а answer cache живёт на fact-only модели. Новое evidence добавляет ещё один ручной cascade. Graph должен помогать закрывать зависимости, а не только рисовать происхождение.

**Слишком сильные обещания в комментариях.** «Never loses», «always reflect standing votes», «re-run repairs», «independent evidence» встречаются там, где есть явно не покрытые сценарии. Исторические длинные комментарии полезно заменять коротким актуальным контрактом и ссылкой на decision record; особенно заметно это в jest-e2e.json.

**Качество retrieval и качество storage нельзя смешивать.** 619 реальных DB e2e и 3 949 unit важны, но модели в e2e подменены. На основании этого аудита нельзя честно утверждать процент улучшения ответов. Новые defaults стоит оценивать на неизменном корпусе с полным feature profile и сопоставимыми cost/latency/abstention/citation результатами; accuracy claims — только с протоколом проекта.

## Что исправлять сначала

1. **Перед ближайшим release:** F1 frontend build, F2 feedback authorization, F3 mixed-evidence cache, F4 promotion visibility, F5 removed-pack consent. У каждого нужен regression test на внешне наблюдаемый результат.
2. **Следующая волна consistency:** F6 watermark/reordering, atomic belief revision, F7 финальная serving telemetry, F8 atomic feedback deltas, F9 suspended roster. Проверки перестановок, конкуренции, crash/retry и удаления между чтением и выдачей.
3. **Затем управляемость:** F10 единица независимого источника, F11 temporal contract, backlink reconcile, полноценный L3 fallback и явный degraded status.
4. **После этого расширение качества:** поддерживаемые profiles, фиксированный baseline, blinded/held-out вопросы и отрицательные сценарии для новых heuristics. Отдельно latency/cost под целевым production profile.

Исходный product-код и deployment не исправлялись: это аудит. Изменения со стороны аудитора — данный отчёт, его диагностические материалы и отдельный временный checkout. Более поздние изменения других процессов не считаются частью выполненной здесь работы.
