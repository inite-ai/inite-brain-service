# CRM as a source — records, not prose (2026-09-17)

Question asked: *a CRM should probably connect through OpenAPI, or some
other way — this needs proper research and a plan, not another native.*

Answer in one line: **a CRM is not a document store, it is a table of
records with a revision — so the hard part is not the transport (there
are five, and every major CRM now offers three of them) but the door:
a record must become deterministic facts with a version stamp, never
prose an LLM re-extracts. Build that door once (`crm_memory` +
attribute → predicate mapping + a push endpoint), then put ONE generic
REST-records runtime behind it whose per-vendor knowledge is data — an
OpenAPI-assisted mapping the operator confirms against a live preview —
and treat the vendors' official MCP servers as the query-time lane, not
the bulk path.**

Method: read what the source plane already has for records
(`connector.ts` `RecordEnvelope`, `source-doors.service.ts`
`structureDoor` / `renderRecord`, the external-candidates grounding in
`documents/external-candidates.service.ts`, the predicate alias registry
0147, pack `memoryModel.stateModels`, the W4.1 OAuth client and
`CredentialProvider`, the W2 harvester), then read how the 2026 field
does it: the vendors' own APIs and their new hosted MCP servers
(HubSpot, Salesforce, Pipedrive, Bitrix24), the unified-API brokers
(Nango, Unified.to, Merge), the OpenAPI-driven connector builders
(Airbyte's declarative manifest + AI assistant), and the OpenAPI → MCP
generators. Every claim about our code carries a path; every claim
about the field carries a source (§ Sources).

---

## 1. What "connect a CRM" means — and what exists

A CRM row (`Deal #4812: Acme, stage = negotiation, amount = 40 000,
owner = Grace, updated 2026-09-15`) is **entities + attributes +
relations + a revision**. Reading it as text and asking an LLM what it
says is wrong three ways: it costs tokens for something already
structured, it can misread `amount` as prose, and it loses the one thing
a CRM gives for free — the revision that makes every attribute
bitemporal (`validFrom` = updated_at; a changed stage closes the old
fact). The source-plane doctrine already names this (**"records are a
shape, not a document"**, raw-evidence-sources-2026-09.md § 5.8) and W0
shipped half of it:

| Piece | State | Where |
|---|---|---|
| `RecordEnvelope { entityType, externalId, name, attributes, relations?, updatedAt? }` | shipped (W0) | `src/source-plane/connector.ts` |
| `structure` door | **renders the envelope deterministically and hands it to the document door** — i.e. the LLM extractor still runs over `key: value` lines | `source-doors.service.ts` `structureDoor` / `renderRecord` |
| Deterministic candidates from attributes | **not built** — the roadmap deferred it to "the first structure-shaped native (W4)" | — |
| External candidates with verbatim grounding, `sourceVersion` stamps, `indexer.mode: 'external'` | shipped | `documents/external-candidates.service.ts`, docs/indexer-protocol.md § Grounding |
| Predicate alias registry (per tenant, `status: aliased`) | shipped (0147) | docs/domain-packs.md § registry |
| Pack `memoryModel.stateModels` (subject-typed lifecycles, transitions → belief deltas) | shipped, default-off (`PACK_MEMORY_PROJECTIONS_ENABLED`) | docs/domain-packs.md § memoryModel |
| PII-gated predicates (`email`, `phone`, `address`, `dob` — scope-gated, external indexers may not seed them) | shipped | docs/indexer-protocol.md § Predicate rules |
| Outbound OAuth client, grants encrypted, `CredentialProvider` | shipped (W4.1, #621) | `src/source-plane/oauth/` |
| MCP harvester — `resources/list` + `resources/read` | shipped (W2); **tools are not driven**, `auth: 'oauth'` to an MCP server is declared but "not available yet" | `connectors/mcp.connector.ts`, `manifest.ts` `PACK_SOURCE_MCP_AUTH` |
| Push: `kind: 'external'` connections + `POST /v1/documents/:id/candidates` | shipped; **no record-batch endpoint** (a pusher must first create a document, then submit candidates) | docs/indexer-protocol.md |
| Eval harness "load your CRM via JSON" (`JsonDirectory`: entities → facts with validFrom/validUntil) | shipped | docs/eval.md § Path A |

So the gap is the **door**, not the pipe. Whatever transport brings the
row, today it becomes a rendered text and an LLM call. Everything below
the door — grounding, stamps, drift, close-on-delete, GDPR, the eval
harness — already works on facts.

## 2. The 2026 field — evidence

### 2.1 Every major CRM ships three ways in

| Vendor | Own API (bulk read, incremental) | Webhooks / CDC | Official MCP server (2026) |
|---|---|---|---|
| **HubSpot** | CRM v3 objects; incremental = Search API filtered by `hs_lastmodifieddate` (contacts: `lastmodifieddate`), cursor `paging.next.after`; **a search window is capped at 10 000 results — narrow the time window and re-run**; the search index is eventually consistent — overlap the window by minutes and dedupe by id [1] | webhooks per object/property | **Remote MCP server GA 2026-04-13** at `mcp.hubspot.com`, OAuth 2.1 + PKCE only, read *and write* over contacts / companies / deals / tickets / … / activities, every plan [2] |
| **Salesforce** | REST + SOQL (`LastModifiedDate > …`, `nextRecordsUrl`), Bulk API 2.0 for large objects | Change Data Capture / Platform Events (Pub/Sub API, gRPC) | **Hosted MCP servers GA 2026-04**, per-user OAuth 2.0 + PKCE, Enterprise Edition and above; DX MCP for developers [3] |
| **Pipedrive** | API v2: `updated_since` + `cursor` on deals / persons / organizations / activities | webhooks v2 | **Native remote MCP** `mcp.pipedrive.ai/mcp`, launched 2026-06-30, OAuth, every plan [4] |
| **Bitrix24** | REST `crm.item.list` (universal, `filter[>updatedTime]`, offset `start` paging), `crm.deal.list` etc.; **two auth modes** — an inbound webhook URL for one portal you control, OAuth 2.0 for a multi-tenant app [5] | outbound webhooks / event subscriptions | **Bitrix24 MCP Server** for third-party AI systems (Manus, Cursor, n8n), acting inside the employee's permissions; a separate MCP-dev server for docs [6] |
| **Kommo (amoCRM)** | API v4: leads / contacts / companies / tasks / notes, OAuth 2.0 per account, `filter[updated_at][from]`, page + `_links.next` [7] | webhooks per entity event | third-party only |
| **Zoho, Freshsales, Close, Attio, Odoo, SuiteCRM, RetailCRM, …** | REST, mostly `modified_since` + page | mostly webhooks | third-party / none |

Two facts fall out of the table:

- **The official MCP servers are agent tools, not exports.** They expose
  `search`, `get`, `create`, `update` tools sized for an assistant's
  turn — not `list everything modified since T` with bulk paging. Our
  harvester reads *resources*; none of these servers offer the CRM as
  resources. Driving their tools for a bulk sync means per-server
  knowledge of which tool lists what and how it pages — the same
  vendor knowledge a native needs, behind a slower wire with per-turn
  rate limits. Their natural place in brain is the **linked lane**
  (raw-evidence-sources W7: a `search`-capable source queried at
  retrieval time), and reaching them needs one missing capability on
  our side: **MCP client OAuth** (RFC 9728 discovery → AS metadata →
  dynamic client registration → PKCE) — the `auth: 'oauth'` the
  manifest already declares.
- **Incremental sync is a solved, boring pattern per vendor**: an
  `updated_since` filter + one of four paging styles (cursor, offset,
  page number, next-link) + an overlap window + id-dedup. That is
  configuration, not code.

### 2.2 Unified-API brokers

Nango: one interface for auth, syncs, webhooks and tool calls across
hundreds of APIs; a *records cache* your app polls or is webhooked
about; you write (or pick) the sync function per provider; partially
open source [8]. Unified.to / Merge / Apideck: a *normalised* Contact /
Deal object across 50+ CRMs with mapping, paging and webhook
normalisation done for you [9]. Trade: coverage of the long tail in one
integration, against a per-seat / per-connection cost, a vendor in the
middle of every record, and normalised objects that flatten exactly the
custom fields a tenant cares about. For a memory product whose pitch is
"your data stays yours", a broker is an opt-in for the long tail, not
the spine — which is what raw-evidence-sources § 8.4 already
recommended ("own for the W4 five behind `CredentialProvider`; Nango
optional").

### 2.3 OpenAPI-driven connectors

Airbyte's answer to "a connector for any REST API" is a **declarative
manifest** (YAML: base URL, auth, streams, paging, incremental cursor)
interpreted by one runtime (`source-declarative-manifest`), authored in
a Connector Builder UI; its **AI assistant reads an OpenAPI spec or the
API docs and pre-fills the base URL, auth, pagination and proposes
streams** [10]. That is exactly the shape the owner's question points
at, and it comes with a warning our doctrine already wrote down: the
manifest *is* a DSL — Airbyte's has hundreds of component types and a
version-skew problem between manifest and CDK [10]. OpenAPI itself does
not carry the semantics a sync needs (which operation *lists* an entity,
which field is the cursor, what "modified since" is called, what a
record's identity is): every "OpenAPI → MCP" generator says the same —
the conversion is lossy and naive one-to-one mapping produces broken
tools [11]. OpenAPI is a **source of suggestions for a mapping**, not a
mapping.

## 3. Doctrine for records (adds to raw-evidence-sources § 4)

9. **A record enters as facts, not as prose.** The record envelope is
   the contract every transport funnels into. Attributes whose key maps
   to a pack predicate become **deterministic candidates** (no LLM);
   relations become edges; a lifecycle attribute (`stage`, `status`)
   becomes a state transition; `updated_at` / the vendor revision is the
   `SourceVersionStamp`. The rendered record is still stored as the
   grounding document (verbatim `key: value` lines), so the existing
   external-candidates grounding, provenance and GDPR paths apply
   unchanged. LLM extraction runs only over free-text attributes the
   mapping names (`notes`, `description`) — a budgeted exception, not
   the default.
10. **Vendor knowledge is data; the runtime is one and bounded.** One
    `rest_records` connector (platform code) knows four paging styles,
    one incremental filter, one auth per connection, one rate-limit
    posture. A vendor is a **preset** — a `crm_memory` `sources[]` entry
    whose `configExample` fills the mapping — and a custom CRM is the
    same mapping filled by hand or proposed from its OpenAPI document
    and **verified by a live preview before the connection exists**.
    The mapping has no expressions, no scripting, no JSONPath beyond
    dotted paths: the moment a vendor needs more, it gets a native (as
    the drives did) or an MCP server (the third-party seam) — never a
    bigger mapping.
11. **Official CRM MCP servers are the query-time lane.** Bulk sync goes
    through the vendor API; the MCP server is what a retrieval hit
    deepens against (W7), through the same connected account.
12. **Push is first-class.** A CRM that can call a webhook (Bitrix24,
    Kommo, HubSpot, Make / n8n / Zapier / Albato in front of anything)
    posts record envelopes to a batch endpoint under a connection and
    needs no brain-side polling at all — the RU/LatAm market's default
    integration style.

## 4. The design

### 4.1 The records door (transport-independent)

```
RecordEnvelope ──▶ structureDoor
   │  render (deterministic, sorted keys) ──▶ document (kind source_record, contentHash dedup)
   │  map attributes ──▶ candidates { entities, facts, relations } grounded verbatim in the render
   │      key ∈ pack vocabulary (localId) or tenant alias (0147)      ⇒ fact, no LLM
   │      key ∈ mapping.lifecycle                                    ⇒ stateDelta (memoryModel.stateModels)
   │      key ∈ mapping.text                                         ⇒ LLM extraction over that value only (budgeted)
   │      key ∈ PII class (email, phone, address, dob)               ⇒ only if the pack declares the scope; else dropped with reason
   │      anything else                                              ⇒ kept in the render (searchable), no fact
   │  relations ──▶ entity relations (contact →company: company_of; deal → contact: primary_contact)
   └─ sourceVersion = { system: <vendor>, ref: <entityType/externalId>, version: <revision|updated_at> }
      → drift sweep marks superseded attributes, `gone` closes them (deletePolicy)
```

- **Mapping = data on the connection** (`config.mapping`), pre-filled
  by the pack entry (preset) or the assistant, editable in the UI:

  ```jsonc
  {
    "entities": [
      { "type": "deal",                       // entityType in the envelope
        "list": { "method": "GET", "path": "/api/v2/deals",
                  "query": { "limit": "500", "sort_by": "update_time" } },
        "items": "data",                      // dotted path to the array
        "paging": { "style": "cursor", "param": "cursor", "next": "additional_data.next_cursor" },
        "incremental": { "param": "updated_since", "format": "iso" },
        "id": "id", "name": "title", "updatedAt": "update_time",
        "fields": { "value": "deal_amount", "stage_id": "deal_stage", "status": "deal_status",
                    "owner_id.name": "owner", "expected_close_date": "expected_close" },
        "relations": { "person_id": { "kind": "primary_contact", "type": "contact" },
                       "org_id": { "kind": "company_of", "type": "company" } },
        "lifecycle": { "field": "stage_id", "model": "deal_stage" },
        "text": ["notes"] }
    ]
  }
  ```

  Four paging styles (`cursor` | `offset` | `page` | `link`), one
  incremental filter (`param` + `format`: iso / unix-ms / unix-s /
  vendor-`>field`), dotted paths only. Bounded on purpose (doctrine 10).

- **Lookups.** A vendor lists stages / owners / pipelines as ids; the
  mapping may name a lookup list operation (`"lookups": { "stage_id": { "path": "/api/v2/stages", "id": "id", "label": "name" } }`)
  so the fact reads `deal_stage: Negotiation`, not `deal_stage: 7`.
- **`crm_memory` pack** (first-party, like `file_memory`): vocabulary
  (`company_of`, `primary_contact`, `owner`, `deal_stage`,
  `deal_amount`, `deal_status`, `expected_close`, `pipeline`,
  `lead_source`, `industry`, `job_title`, `last_activity_at`, `won_at` /
  `lost_at` / `lost_reason`, `ticket_status`, `priority`; PII predicates
  through the existing scope gate), `stateModels` (`deal_stage` with
  the transitions the preset's pipeline maps onto; `ticket_status`),
  `source_version_match` verification rules so a stale attribute is
  marked on drift, `sources[]` = one entry per vendor preset + `custom`
  (OpenAPI / manual) + `push`, `evalFixtures` with a synthetic CRM.
- **Push endpoint** `POST /v1/source-connections/:id/records` — a batch
  of envelopes (≤ 200) with a `sourceVersion`, `brain:write`, the
  connection's recorder; `gone: [externalId]` in the same body. A
  Bitrix24 outbound webhook, a Make/n8n scenario or a nightly script is
  a connection of kind `external` + this endpoint — no polling, no
  credential on the brain.

### 4.2 One direction, per-vendor connectors — the records contract

Owner's call (2026-09-17): **every CRM gets its own connector; what is
unified is the direction.** So the shared part is not a generic REST
runtime but a **records contract** every CRM connector implements, and
one engine-side runtime that turns it into the connector verbs:

```ts
interface RecordsSource {                       // what a vendor connector implements
  readonly kind: string;                        // 'pipedrive' | 'hubspot' | 'bitrix24' | 'kommo' | …
  readonly oauth?: { provider; scopes };        // or a plain credential (API token, webhook URL)
  entities(ctx): EntitySpec[];                  // { type: 'deal', label, defaultOn, fields: [...] } — what it can list
  list(ctx, entity, cursor: { since?: string; page?: unknown }): Promise<{ records: RecordEnvelope[]; next?: unknown }>;
  get?(ctx, entity, externalId): Promise<RecordEnvelope | null>;   // webhooks fetch-one
  lookups?(ctx): Promise<Record<string, Record<string, string>>>;  // stage id → label, owner id → name
  verifyWebhook?(headers, body): boolean;       // the vendor's signature
}
```

`records-runtime.ts` (platform, once) does the rest: per-entity
checkpoints with an overlap window and id-dedup, `externalId =
<entity>/<id>`, `revision = updatedAt | vendor version`, lookups
resolved into the envelope, the gone sweep on a full walk, the same
`structure` door for every vendor. A vendor connector is therefore
~150 lines: auth, `list` with its own paging and `updated_since`
spelling, `get`, lookups, its **preset mapping** (§ 4.1) and its
webhook signature. The generic OpenAPI-configured connector of § 4.3
is then just one more `RecordsSource` whose `list` is driven by the
mapping — for the long tail, not the spine.

What is unified, concretely: (1) the envelope and the door (facts,
stamps, lifecycle, relations — § 4.1); (2) the `RecordsSource` contract
and the runtime (paging, overlap, dedup, gone); (3) one `crm_memory`
vocabulary + canonical funnel states that every vendor's stages map
onto; (4) one UI flow (vendor → account → entities → field mapping →
preview → sync); (5) one sync-correctness matrix run against a fake
vendor and a real sandbox per connector.

### 4.2.1 Vendor presets

Every vendor connector rides `cloud-http.ts` (bearer / basic / header /
connected-account credential; 429 / 5xx backoff; bounded bodies; every
hop through the egress guard; private hosts by the double opt-in for a
self-hosted CRM on the LAN). First four by market fit — RU/LatAm SMB
(Bitrix24, Kommo) and global SMB (HubSpot, Pipedrive) — each a
`crm_memory` `sources[]` entry naming its connector, with the preset
field mapping as `configExample`:

| Preset | Auth | List / incremental / paging | Notes |
|---|---|---|---|
| `bitrix24` | OAuth 2.0 app (portal-scoped tokens, refresh at `oauth.bitrix.info`) **or** inbound webhook URL (a `credential`, no OAuth) | `crm.item.list` per `entityTypeId` with `filter[>updatedTime]`, `order`, `start` offset, 50/page | universal method covers deals / leads / contacts / companies / SPAs; custom fields `UF_*` |
| `kommo` | OAuth 2.0 per account subdomain (`https://<sub>.kommo.com` / `.amocrm.ru`) | `/api/v4/{leads,contacts,companies,tasks,notes}` with `filter[updated_at][from]`, `page` + `_links.next`, 250/page, `with=` for embedded relations | pipelines / statuses as lookups |
| `hubspot` | OAuth 2.0 (scopes per object) or private-app token | Search API per object with `hs_lastmodifieddate` GT + `after` cursor; **10 000-per-window cap ⇒ time-window narrowing built into the runtime**; associations endpoint for relations | `lastmodifieddate` for contacts |
| `pipedrive` | OAuth 2.0 or API token | `/api/v2/{deals,persons,organizations,activities}` with `updated_since` + `cursor` | stages / users as lookups |
| `salesforce` (W4.2c) | OAuth 2.0 web flow / JWT bearer | SOQL `SELECT … WHERE LastModifiedDate > :since` with `nextRecordsUrl`; Bulk API 2.0 for the first walk | field-level security applies as the user |
| `custom` | any | filled by hand or from an OpenAPI document | § 4.3 |

The runtime never contains the word "HubSpot"; the window narrowing
HubSpot's search cap needs lives in the HubSpot connector's `list`.

### 4.3 The OpenAPI-assisted mapping (the owner's question, answered)

For a custom CRM / ERP / ticketing backend the operator gives the brain
its OpenAPI document (a URL — egress-guarded — or a paste) and the
brain **proposes** the mapping:

1. Parse the spec; keep the read-only list-shaped operations (GET
   returning arrays of objects; POST search endpoints flagged as such).
2. Ask the tenant's default model, under a strict JSON schema
   (`config.mapping` above), for: which operations are entity lists,
   the entity type name, the id / name / updated-at fields, the paging
   style and its parameters, the incremental filter, the relation
   fields — each with a one-line reason and a confidence.
3. **Verify by execution**: run each proposed list operation for one
   page against the live API with the connection's credential; show the
   operator the first five records per entity as the mapping renders
   them (the envelope, the facts it would produce, the fields left
   unmapped). Nothing is committed until the preview ran.
4. The operator edits in a table (entity on/off, field → predicate
   dropdown fed by the pack vocabulary + the tenant's aliases, "treat
   as text", "lifecycle"), re-previews, connects.

This is Airbyte's assistant pattern [10] with two deliberate
differences: the mapping is bounded (no DSL to grow), and the proposal
is never trusted — the preview is the truth. Without an OpenAPI
document the same table is filled by hand (paste one sample JSON
response; the assistant proposes the field mapping from it).

### 4.4 Freshness — webhooks and CDC (W4.2c)

Polling every hour is enough for facts that live weeks; a deal stage
change wants minutes. Each preset that has webhooks gets an **inbound
webhook** under the connection (`POST /v1/source-connections/:id/webhook`,
vendor signature verified: HubSpot v3 signatures, Pipedrive basic auth
on the webhook, Bitrix24 `application_token`, Kommo none — then the
event names the entity + id and the runtime fetches that one record).
Salesforce CDC over Pub/Sub (gRPC) is the odd one out and waits for
demand. The webhook never carries data into memory directly — it only
schedules a fetch, so the same door and the same grounding apply.

### 4.5 MCP client OAuth (W4.3) — reaching the official servers

The manifest already allows `auth: 'oauth'` on an MCP source; the UI
says "not available yet". With the W4.1 client in place the missing
piece is the MCP authorization flow: RFC 9728 protected-resource
metadata from the server's 401 → the authorization server's metadata →
**dynamic client registration** (RFC 7591) when the AS supports it (the
2026 MCP revision's default; HubSpot / Pipedrive / Salesforce / Bitrix24
all run OAuth 2.1 + PKCE) → PKCE → a grant of a new provider kind
`mcp:<server origin>`. Then:

- any hosted MCP server becomes connectable by URL with a "Sign in"
  button (the same account picker as the drives);
- the harvester keeps reading resources where a server offers them;
- for the CRM servers, **W7's linked lane** calls their `search` tool at
  retrieval time and records hits as tool observations (0111) — a fresh
  answer about a deal that changed a minute ago, without syncing every
  deal every minute.

Bulk sync through those tools is deliberately *not* built (§ 2.1).

### 4.6 UI

One card **"CRM / records system"** (family `records`) → *vendor*
(HubSpot · Pipedrive · Bitrix24 · Kommo · Salesforce · Custom REST /
OpenAPI · Push) → *account* (the account picker; a Bitrix24 webhook URL
or a Pipedrive token as the plain-credential alternative) → *what to
sync* (entities as checkboxes from the preset / the proposal; per
entity the field → predicate table with the unmapped fields listed,
"text" and "lifecycle" toggles) → *preview* (five records per entity,
the facts they yield) → *how it syncs*. The drill-down already shows
runs, catalogue rows and an item followed to its facts; a record's
facts read `deal_stage: Negotiation (v 2026-09-15T10:00Z)`.

## 5. Scenario check

| Scenario | Path | Wave |
|---|---|---|
| Pipedrive / HubSpot SMB | preset + connected account; hourly + webhooks | W4.2b / c |
| Bitrix24 portal (RU) | preset + inbound webhook URL (no OAuth app needed for one's own portal) or OAuth app; outbound webhook for freshness | W4.2b / c |
| Kommo (RU / LatAm) | preset + OAuth; webhooks | W4.2b / c |
| Salesforce enterprise | preset (SOQL + Bulk) + OAuth; CDC later | W4.2c |
| Custom in-house CRM with an OpenAPI doc | `custom` + assistant + preview | W4.2b |
| Custom CRM without docs but with a DB | `db` connector on the agent (read-only views → envelopes; DSN stays local) | W4.4 |
| Anything behind Make / n8n / Zapier / Albato | `push` connection + records endpoint | W4.2a |
| "Ask the CRM now" (fresh, exact) | official MCP server via MCP client OAuth, linked lane | W4.3 / W7 |
| Long tail (Zoho, Close, Attio, …) | `custom` preset written once as data, or a broker behind `CredentialProvider` | W4.2b / opt-in |

## 6. Waves

| Wave | Delivers | Flag | Proves |
|---|---|---|---|
| **W4.2a Records door** | **shipped (#623)** — attribute → predicate deterministic candidates in `structureDoor` (grounded in the render; PII gate; lifecycle → stateDelta; relations → edges; text fields → budgeted LLM); `crm_memory` pack (vocabulary, state models, verification rules, eval fixtures); `POST /v1/source-connections/:id/records` (push, batch, gone); drill-down shows the version on each fact | `SOURCE_RECORDS_DOOR` | a synthetic CRM pushed as envelopes answers the eval harness's questions with **zero LLM calls**; a stage change closes the old fact |
| **W4.2a′ `RecordsSource` contract + records runtime + first connector** | **shipped (#623)** — the contract, the runtime (per-entity checkpoints, overlap + dedup, lookups, gone on a full walk), `pipedrive` as the first vendor (OAuth or API token; deals / persons / organizations), the CRM card with entities + field mapping + preview | `SOURCE_KIND_PIPEDRIVE` | the sync-correctness matrix against a fake Pipedrive; one real sandbox |
| **W4.2b more vendors + OpenAPI assistant** | `bitrix24`, `kommo`, `hubspot` connectors on the contract — **shipped (#624)**: HubSpot as a connected account (`hubspot` provider, scopes per object, identity by token) or a private-app token, Search-API windows narrowed at the 10 000 cap, associations per page; Bitrix24 on an inbound webhook URL (stored encrypted, code never echoed; OAuth per portal deferred); Kommo on a long-lived token + `baseUrl` (OAuth on the account host deferred to W4.3's per-origin provider lane); the OpenAPI/JSON-sample-driven `RecordsSource` for the long tail with the assistant + live preview — **shipped (#625)**: `rest_records` (config: endpoints per entity, five paging styles, one since-parameter, dotted field paths, relations, deleted flag; auth bearer / basic / header / query) + `POST …/assist` (OpenAPI digest with `$ref` / `allOf` / POST body params, sample answers, conventional-name heuristics always, one strict-schema model call under the flag) + the "Describe the API" step in the connect form | per kind, `SOURCE_MAPPING_ASSISTANT` | one real sandbox per connector (fake vendors in `test/fixtures/fake-crm.ts`; real sandboxes await the operator's apps) |
| **W4.2c Freshness + Salesforce** | inbound webhooks per preset (signature verified, fetch-one); Salesforce preset (SOQL + Bulk 2.0) | per preset | change at source → fact queryable ≤ 60 s with a webhook |
| **W4.3 MCP client OAuth** | RFC 9728 → DCR → PKCE; provider kind `mcp:<origin>`; "Sign in" on MCP sources; W7 linked lane over the official CRM servers' `search` | `SOURCE_MCP_OAUTH` | HubSpot's and Pipedrive's hosted servers connected from the UI; a retrieval hit deepened live |
| **W4.4 `db` on the agent** | read-only Postgres / MySQL / SQLite views → envelopes, DSN never leaves the machine | agent config | a self-hosted CRM's DB read where it lives |
| opt-in | broker (`CredentialProvider` implementation + a `broker_records` connector) | — | long tail in one integration, at the owner's call |

W4.2a is the spine and is transport-free: it is what makes every later
wave — and the existing `mcp` harvester, if a server ever offers records
as resources — produce facts instead of prose.

## 7. Measurement

| Leg | Method | Pass |
|---|---|---|
| Deterministic coverage | per preset sandbox: share of attributes that became facts without an LLM | ≥ 90 % of mapped fields; 0 LLM calls on a run with no `text` fields |
| Sync-correctness matrix | per preset: create / update / stage change / relation change / delete / restore × full / incremental | expected `source_item.state`, fact `validFrom` / `validUntil`, state transition recorded |
| Idempotency | run twice unchanged | 0 rows written (contentHash dedup on the render) |
| Freshness | webhook on, change at source | fact queryable ≤ 60 s; polling ≤ schedule + processing |
| Assistant accuracy | 10 public OpenAPI docs (Pipedrive, HubSpot, Bitrix24, Kommo, Odoo, SuiteCRM, Close, Attio, Freshsales, an in-house sample) | entity lists found ≥ 9/10; id / updated-at / paging right ≥ 8/10 before the preview; the preview catches the rest |
| End-to-end QA | the eval harness's CRM JSON pushed as envelopes vs. synced through a fake vendor | identical retrieval + lifecycle scores |
| Leakage | two users, one org CRM connection, owner-scoped records (G6) | 0 cross-user hits |

## 8. Decisions for the owner (recommendations first)

1. **Records door before any transport?** Recommend yes — W4.2a first;
   it is small, transport-free and turns the existing `structure` shape
   from prose into facts.
2. **One generic runtime with vendor presets as data, or a connector
   per vendor?** Owner's call: **a connector per vendor**, unified by the
   `RecordsSource` contract + one records runtime (§ 4.2); the generic
   OpenAPI-driven one is a `RecordsSource` for the long tail.
3. **OpenAPI: assistant + live preview, or manual only?** Recommend the
   assistant (the tenant's default model, strict JSON, never trusted —
   the preview is the truth); manual stays available.
4. **Which four presets first?** Recommend Bitrix24, Kommo, HubSpot,
   Pipedrive (RU / LatAm + global SMB — the partner list); Salesforce in
   W4.2c.
5. **Official CRM MCP servers: linked lane only?** Recommend yes; bulk
   sync through their tools is the wrong wire.
6. **Broker (Nango / Unified.to)?** Recommend not now; the seam is
   there when the long tail asks.
7. **Push endpoint scope?** Recommend `brain:write` under the
   connection's recorder, batch ≤ 200, same grounding — so Make / n8n /
   Bitrix24 outbound webhooks need nothing but a URL and a key.

## Sources

1. HubSpot community + integration guides on incremental sync — `hs_lastmodifieddate` filter, `paging.next.after`, the 10 000-result window cap, eventual consistency and overlap: https://community.hubspot.com/t5/APIs-Integrations/Filtering-by-hs-lastmodifieddate-in-Search-API/m-p/733516 , https://insightsalesglobal.com/blog/hubspot-recently-updated-contacts-api
2. HubSpot — "Remote HubSpot MCP server is now generally available" (2026-04-13; OAuth 2.1 + PKCE; objects, marketing, activities): https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available , https://developers.hubspot.com/ai-tools/mcp
3. Salesforce Developers — "Salesforce Hosted MCP Servers Are Now Generally Available" (2026-04) and "Introducing MCP Support Across Salesforce": https://developer.salesforce.com/blogs/2026/04/salesforce-hosted-mcp-servers-are-now-generally-available , https://developer.salesforce.com/blogs/2025/06/introducing-mcp-support-across-salesforce
4. Pipedrive — native MCP server launch (2026-06-30, `mcp.pipedrive.ai/mcp`, OAuth, every plan): https://www.pipedrive.com/en/newsroom/pipedrive-launches-native-mcp-server-bringing-crm-workflows-directly-into-ai-assistants , https://www.pipedrive.com/en/features/mcp-server
5. Bitrix24 REST docs — `crm.item.list`, `crm.deal.list`, authorization (inbound webhook vs OAuth 2.0): https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-list.html , https://apidocs.bitrix24.com/settings/how-to-call-rest-api/authorization.html
6. Bitrix24 — "MCP in Bitrix24" (MCP Server for third-party AI systems within employee permissions; MCP-dev for docs): https://helpdesk.bitrix24.com/open/25846367/ , https://apidocs.bitrix24.com/ai-tools/mcp.html
7. Kommo developers — OAuth 2.0; API v4 clients documenting `updated_at` filters, paging and webhooks: https://developers.kommo.com/docs/oauth-20 , https://github.com/ufee/amoapi-v4
8. Nango — what a unified API is; records cache / syncs / webhooks: https://nango.dev/blog/what-is-a-unified-api/ , https://nango.dev/blog/best-unified-api-for-crm-erp-integrations/
9. Unified.to — "Nango vs Unified.to" (normalised objects across 50+ CRMs): https://unified.to/blog/nango_vs_unified_build_your_own_unified_api_or_use_one
10. Airbyte — declarative manifest source, low-code CDK, Connector Builder AI assistant from an OpenAPI spec; manifest / CDK version skew: https://docs.airbyte.com/platform/connector-development/connector-builder-ui/ai-assist , https://docs.airbyte.com/connector-development/config-based/low-code-cdk-overview , https://pypi.org/project/airbyte-source-declarative-manifest/ , https://github.com/airbytehq/airbyte/issues/45398
11. Speakeasy — generating MCP tools from OpenAPI: benefits, limits (lossy, naive 1:1 breaks): https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi ; FastMCP OpenAPI integration: https://gofastmcp.com/integrations/openapi
12. Our own: docs/roadmap/raw-evidence-sources-2026-09.md § 5.8 / § 8; docs/indexer-protocol.md (grounding, ungrounded, predicate rules); docs/domain-packs.md (registry aliases, memoryModel); docs/eval.md § Path A (the CRM JSON directory); docs/source-plane.md § Connected accounts (W4.1).
