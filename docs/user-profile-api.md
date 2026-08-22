# User Profile API (rolling user profile, v1)

`GET /v1/users/:userId/profile` — a deterministic, query-time assembly of
what the platform knows about one end-user, shaped for direct prompt
injection by consumers (paste `profileText` into a system prompt as-is).

Deterministic v1 — no narrative synthesis yet: the profile is a grouped,
capped, stably-ordered projection of the stored fact rows; no LLM call
happens anywhere on this path, and the same memory state always renders
the same profile. The intended v2 folds these facts into a rolling
LLM-written narrative that is updated incrementally as new facts land,
instead of being re-derived from scratch per request.

## Enabling

Gated by `USER_PROFILE_API_ENABLED` (default off). While off, the routes
answer 404 — indistinguishable from an absent route. Read per-request, so
a flip needs no restart.

## Auth semantics

- Guard: API key / bearer token, scope `brain:read`, ABAC action
  `get_user_profile` (read kind).
- User-scope pin (migration 0055 semantics): an M2M credential may fetch
  any user's profile; a user-bound token (auth-service token with
  `org` + `sub`) may fetch only its own — a mismatching `:userId` is 403.
- Visibility is STRICT user scope (audit 2026-08-21): only the named
  user's personal rows (`userId = $user`) — a tenant-global row is
  knowledge about an arbitrary entity, not established to be about this
  user, and never enters a profile. The user's own derived facts carry
  `userId` by construction (the deriver's grounding-turn scope rule).
  Tenant-global rows with an explicit subject/entity binding to the
  user are the documented v2. The rest of the read contract: the
  pinned derived world unioned with the legacy namespace
  (`derivedVersion IS NONE OR <read-pin fence>`), lifecycle-closed rows
  excluded (retracted / superseded / compacted / corroborating /
  competing), and the registry-backed row policy applied — predicates
  fenced with `requiresScope: brain:read_pii` appear only for callers
  holding that scope.

## Request

| Param | In | Meaning |
| --- | --- | --- |
| `userId` | path | End-user scope key (pinned as above). |
| `maxFacts` | query | Global fact budget. Default 60, hard cap 200. |
| `lang` | query | Locale filter: keeps facts with this `lang` or none. |

## Response

```json
{
  "userId": "did:key:z6MkUser",
  "generatedAt": "2026-08-21T10:00:00.000Z",
  "factCount": 3,
  "sections": [
    {
      "aspect": "identity",
      "facts": [
        {
          "factId": "knowledge_fact:f001",
          "statement": "Alex is a vegetarian",
          "validFrom": "2026-01-15T00:00:00.000Z",
          "confidence": 0.9,
          "kind": "persona_attr"
        }
      ]
    },
    {
      "aspect": "work",
      "facts": [
        {
          "factId": "knowledge_fact:f002",
          "statement": "Alex works at Acme",
          "validFrom": "2026-02-03T12:00:00.000Z",
          "confidence": 0.85,
          "lastSeenAt": "2026-07-01T00:00:00.000Z"
        },
        {
          "factId": "knowledge_fact:f003",
          "statement": "Alex leads the search team",
          "validFrom": "2026-01-20T00:00:00.000Z",
          "confidence": 0.8
        }
      ]
    }
  ],
  "profileText": "- [identity] Alex is a vegetarian (as of 2026-01-15)\n- [work] Alex works at Acme (as of 2026-02-03)\n- [work] Alex leads the search team (as of 2026-01-20)"
}
```

## Assembly rules (all deterministic)

- Facts group by predicate — an aspect slug (`identity`, `work`, …) in
  derived worlds, a vocabulary predicate for ingested facts.
- `statement` is the fact object verbatim; `kind` surfaces `source.kind`
  when the typed deriver stamped one; `lastSeenAt` surfaces
  `corroboration.lastAt` (last independent corroboration) when any.
- Within a section: `validFrom` DESC, ties by `factId` ASC.
- Section order: sections containing a `persona_attr` atom first, then
  fact count DESC, then aspect ASC.
- Caps: 5 facts per aspect, then the global `maxFacts` budget applied
  walking sections in their final order.
- `profileText` is one line per fact in exactly the response order:
  `- [aspect] statement (as of YYYY-MM-DD)`.
