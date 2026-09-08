# Evidence battery

Fifth mechanical battery, sibling of
[`test/eval/memory-fitness`](../memory-fitness/README.md) (first-person
memory fitness), [`test/eval/state-transitions`](../state-transitions/README.md)
(mutable world-state), [`test/eval/domain-packs`](../domain-packs/README.md)
(installed industry packs) and [`test/eval/code-memory`](../code-memory/README.md)
(the builtin coding pack). This one isolates a different claim from all
four: **bytes handed to the brain stay accountable end to end.**

The chain under test is the evidence plane in order —

```
upload → quarantine scan → processing_run → fragment → citation
       → signed-URL gateway → grants → GC → GDPR erasure
```

— across migrations 0114 (blob-GC outbox), 0121 (broker / processing_run
/ quarantine), 0122 (grants), 0124 (fragment content search) and 0125
(access audit + signed URLs).

Two things make it different from the four siblings:

- **Zero model spend.** Nothing on the evidence plane calls a model, so
  the whole battery scores against a stand booted with a placeholder
  `OPENAI_API_KEY`. The one exception — the serving leg of E4, which can
  only be read through `synthesize` — is opt-in behind
  `EVEV_ALLOW_SYNTHESIZE=1` and skipped by default.
- **It brings its own pack.** The plane is gated on pack DECLARATIONS,
  not just on flags: the broker dispatches only capabilities a pack's
  `memoryModel.processors` asked for, and the raw-read gateway serves
  bytes only for a tenant holding current consent to a pack declaring
  `memoryModel.rawEvidence.serve`. **No installable pack can supply that
  today.** Five of the six builtins omit `rawEvidence` deliberately
  (omission = deny); the sixth, `real_estate`, declares it — but the
  gateway's consent fold reads `domain_pack` rows, and a builtin never
  writes one (it is seeded globally through `SEED_PREDICATES`, and
  install rejects its id), so it can never carry the
  `acceptedModalities` + checksum pair the fold requires. Without a
  fixture pack the entire read half would therefore be unreachable
  rather than measured. `fixtures.ts` installs a run-scoped probe pack
  (and a deny twin, for the negative dispatch case).

## Dimensions

| id  | name              | what a failure would mean                                                                                |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| E1  | ingest & identity | bytes are not content-addressed, dedup forks a row, or a bad blob is stored instead of refused            |
| E2  | quarantine        | external bytes enter without the scan seam, or a flagged blob becomes evidence                            |
| E3  | processing        | a declared processor need does not reach a terminal run, replays non-idempotently, or fails silently      |
| E4  | fragments         | a citation target cannot be attached over real bytes, or a bad locator writes rows                        |
| E5  | citations         | **the north star** — a citation does not unroll to the exact fragment and blob it names                   |
| E6  | access            | a signed URL outlives its TTL, crosses a tenant, survives revocation, or its signing key is readable      |
| E7  | gc                | a referenced blob is collected, or an orphan is not                                                       |
| E8  | gdpr              | erasure leaves a user's evidence behind, or takes a co-owner's / co-tenant's with it                      |

## Check battery

All mechanical: status codes, sha256 comparisons and documented response
counters. No LLM judge (`checks-plane.ts` for E1–E4, `checks-access.ts`
for E5–E8; `checks.ts` is the ordered table).

| id                                | dim | gap-gated | What would falsify the claim                                                              |
| --------------------------------- | --- | --------- | ------------------------------------------------------------------------------------------ |
| e01-blob-upload                   | E1  |           | the server trusts a caller's hash, lands the blob outside the tenant, or not `hot`         |
| e02-content-dedup                 | E1  |           | identical bytes from one owner mint a second row/blob                                      |
| e03-dedup-probe-closed            | E1  |           | the 409 on a foreign principal's known hash names the stored row (existence oracle)        |
| e04-empty-part-rejected           | E1  |           | a zero-byte part becomes an observation                                                    |
| e05-media-type-matrix             | E1  |           | `text/plain` bytes register as modality `image` (silent re-classification)                 |
| e06-size-cap                      | E1  |           | a blob over `EVIDENCE_MAX_BYTES` is stored                                                 |
| e07-external-ingest-fence         | E2  |           | bytes over HTTP enter without a quarantine stamp — or, seam off, are not refused           |
| e08-scan-hook-rejects             | E2  | yes       | a scanner-flagged blob is accepted (today: the platform ships only the allow-all stub)     |
| e09-rejected-stays-rejected       | E2  | yes       | a rejected upload leaves a row a re-upload could resurrect                                 |
| e10-dispatch-terminal             | E3  |           | a declared `document → text` need produces no run, or one that failed/was denied           |
| e11-dispatch-idempotent           | E3  |           | re-dispatching the same key re-runs the adapter instead of replaying                       |
| e12-undeclared-capability-denied  | E3  |           | a need no adapter can serve is silently skipped instead of denied with a reason            |
| e13-failed-run-visible            | E3  | yes       | a failed processing run is invisible to an operator (no read surface exists)               |
| e14-fragment-append               | E4  |           | a citation target cannot be attached to already-stored bytes via the dedup path            |
| e15-locator-matrix                | E4  |           | a `charRange` on an image is stored instead of failing the whole request                   |
| e16-fragment-served               | E4  | yes       | fragment text is not searchable where the contract says (lane + citations default-off)     |
| e17-fragment-unrolls-to-blob      | E5  |           | **the north star** — a fragment does not stream its asset's exact bytes, or drops a header |
| e18-signed-unroll                 | E5  |           | the same unroll fails through a signed URL                                                 |
| e19-citation-target-fence         | E5  |           | a fragment unrolls to another asset's bytes, or an unknown id is distinguishable           |
| e20-signed-url-expiry             | E6  |           | a token outlives `EVIDENCE_SIGNED_URL_TTL_SECONDS`                                         |
| e21-cross-tenant-refusal          | E6  |           | tenant B can stream or mint over tenant A's asset                                          |
| e22-grant-revocation-backstop     | E6  |           | revoking every grant leaves the read open, or a pre-revocation token still redeems         |
| e23-signing-secret-not-readable   | E6  |           | `GET /v1/admin/config` hands the raw signed-URL HMAC key to any `brain:admin` key          |
| e24-orphan-gc-referenced-blob     | E7  | yes       | an orphan sweep touches a referenced blob (today: no sweep exists — PR #481)               |
| e25-shared-asset-survives-forget  | E7  |           | a co-owned asset loses its row, fragments or bytes when one owner is erased                |
| e26-shared-blob-drainer           | E7  | yes       | two rows sharing one blob lose the survivor's bytes (unreachable over HTTP — see below)    |
| e27-forget-erases-user-evidence   | E8  |           | erasure leaves the user's assets, fragments, representations, grants or citations behind   |
| e28-co-owner-grant-survives       | E8  |           | the co-owner's grant dies with the erased user's, or the erased user's grant survives      |
| e29-co-tenant-bytes-survive       | E8  |           | a second tenant's byte-identical content is destroyed by the first tenant's erasure        |

## Honest-baseline policy (`expectedUnknown`)

Same rule as the domain-pack and code-memory siblings, and the reason the
gates are **computed from the live stand** (`GET /v1/admin/config`, a
probe of the orphan-GC route, the install result of the fixture packs)
rather than hardcoded: a check that cannot run reports `skipped` with the
reason it OBSERVED, never a silent pass. The standing gaps:

- **e08 / e09** — the only `EvidenceScanHook` the platform ships is
  `AllowAllScanHook`. The battery does not assume this: it uploads the
  EICAR test string and reports what came back. A `rejected` verdict
  flips both checks to real assertions with no edit here.
- **e13** — 0121 ships the `processing_run` lifecycle but no read
  surface. The dispatch sweep returns counters
  (`assets/dispatched/runs/denied/failed`) in which a failed run is
  indistinguishable from a succeeded one, so "recorded as failed, not
  silently dropped" cannot be observed over HTTP at all.
- **e16** — `RETRIEVAL_FRAGMENT_LANE` and `EVIDENCE_FRAGMENT_CITATIONS`
  are default-off, and the only reader is a generator call.
- **e24** — the orphan-blob GC sweep is not in `main` (it lands with
  PR #481). Today an unreferenced blob is never collected at all.
- **e26** — the defect is real and named in PR #481's own follow-up note:
  the 0114 drainer (and the user-forget cascade) delete a queued
  `storageRef` **unconditionally**, so a blob shared by two asset rows
  loses its bytes when one row dies. Its precondition cannot be built
  over HTTP — `byteHash` is UNIQUE per tenant and the upload path derives
  the ref from the hash, so two rows never share one ref through any
  sequence of API calls. It is recorded here as an open finding rather
  than quietly dropped; closing it needs a test at the service seam.

e25 is the reachable half of the same law and is **not** gap-gated: a
co-owned asset (two live grants, one owner erased) must keep its row, its
fragments and its bytes.

## Running against a local stand

Never run in CI — the runner exits with a usage message when
`BRAIN_BASE_URL` is unset.

- **A FRESH tenant per run** (`BRAIN_COMPANY_ID`). Every user handle,
  pack id and byte payload is salted with the run id, so re-runs cannot
  dedupe onto an earlier run's content-addressed rows — but the erasure
  phase is real, so do not point this at a tenant holding anything you
  want.
- The key needs `brain:read + brain:write + brain:admin`. Deliberately
  **not** `brain:read_media`: every fixture registers `piiClasses` as
  `[]` ("classified clean"), so the media-PII gate is exercised in its
  open state without widening the credential.

Stand flags that shape coverage (all read back through
`GET /v1/admin/config` and reported in the scorecard's `setup` trail):

| knob                              | needed for                            |
| --------------------------------- | ------------------------------------- |
| `EVIDENCE_SUBSTRATE_ENABLED=1`    | everything (the write seam)           |
| `EVIDENCE_BLOB_UPLOAD_ENABLED=1`  | E1, E2 — the byte surface             |
| `EVIDENCE_QUARANTINE=1`           | E2, and any external ingest at all    |
| `EVIDENCE_INGEST_ENABLED=1`       | E4, E5 — fragments over stored bytes  |
| `EVIDENCE_PROCESSOR_BROKER=1`     | E3                                    |
| `EVIDENCE_RAW_READ_ENABLED=1`     | E5, E6, E7, E8 reads                  |
| `EVIDENCE_SIGNED_URL_SECRET`      | E5's signed leg and E6 (≥ 32 chars)   |
| `EVIDENCE_GRANTS_API_ENABLED=1`   | E6's revocation leg, E8's owner list  |
| `EVIDENCE_FS_ROOT=<dir>`          | the fs storage adapter                |
| `EVIDENCE_MAX_BYTES=1048576`      | e06 (a 1 GiB default is not probeable)|
| `EVIDENCE_SIGNED_URL_TTL_SECONDS` | e20 (≤ `EVEV_MAX_WAIT_S`, default 90) |

Then:

```bash
BRAIN_BASE_URL=http://localhost:3055 \
BRAIN_API_KEY=... \
BRAIN_COMPANY_ID=<fresh tenant> \
EVEV_TENANT_B_ID=<second tenant> EVEV_TENANT_B_KEY=... \
pnpm eval:evidence
```

Knobs (`EVEV_` prefix, mirroring the siblings' `MEMFIT_` / `STEV_` /
`DPEV_` / `CMEV_`): `EVEV_RUN_ID` (default time-derived),
`EVEV_TENANT_B_ID` + `EVEV_TENANT_B_KEY` (without them the two
cross-tenant checks are SKIPPED, never passed), `EVEV_MAX_WAIT_S`
(default 90 — the ceiling on waiting out a signed-URL TTL),
`EVEV_ALLOW_SYNTHESIZE=1`, `EVEV_REPORT_DIR` (default `var/evidence/`).

The JSON scorecard lands in `var/evidence/evidence-<runId>.json` — the
per-dimension tallies, the phase-0 setup trail (live knob values, pack
install outcome, orphan-GC probe status, every minted asset id, the
dispatch counters, the erasure result), the gap-gated id list, and every
verdict with its detail, so any line is reproducible from the report file
alone. The battery always exits 0: it reports, it does not gate CI.
