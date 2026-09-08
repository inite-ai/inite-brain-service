/**
 * The evidence battery's check table — id, dimension, intent and
 * assertion in one place, so the README table and the JSON report are
 * generated from the same source rather than kept in sync by hand.
 *
 * The list is SPLIT around the one irreversible act on the plane: GDPR
 * erasure. Everything in `CHECKS_BEFORE_FORGET` runs against a live
 * corpus; the runner then erases one user; `CHECKS_AFTER_FORGET` measures
 * the aftermath. A single flat list would have made the ordering
 * dependency invisible and one reordering away from meaningless.
 */
import type { Ctx } from './context';
import * as plane from './checks-plane';
import * as access from './checks-access';
import type { CheckDef, Verdict } from './types';

export interface Check extends CheckDef {
  run: (ctx: Ctx) => Verdict | Promise<Verdict>;
}

export const CHECKS_BEFORE_FORGET: Check[] = [
  {
    id: 'e01-blob-upload',
    dimension: 'E1',
    intent:
      'bytes handed to POST /v1/ingest/evidence-blob land hot, content-addressed under the ' +
      "caller's own tenant, with the server measuring the identity instead of trusting it",
    run: plane.e01BlobUpload,
  },
  {
    id: 'e02-content-dedup',
    dimension: 'E1',
    intent: 'the same bytes from the same owner produce one blob and one row, not two',
    run: plane.e02ContentDedup,
  },
  {
    id: 'e03-dedup-probe-closed',
    dimension: 'E1',
    intent:
      'a foreign principal registering a known byteHash gets a bare 409 that names nothing — ' +
      'content identity is not an existence oracle',
    run: plane.e03DedupProbeClosed,
  },
  {
    id: 'e04-empty-part-rejected',
    dimension: 'E1',
    intent: 'an empty file part is a 400, never a zero-byte observation',
    run: plane.e04EmptyPartRejected,
  },
  {
    id: 'e05-media-type-matrix',
    dimension: 'E1',
    intent:
      'the (modality, mediaType) pairing is enforced — modality drives pack consent, the ' +
      'dispatch gate and the locator matrix, so a mismatch must be a 400, not a re-classification',
    run: plane.e05MediaTypeMatrix,
  },
  {
    id: 'e06-size-cap',
    dimension: 'E1',
    intent: 'a blob over EVIDENCE_MAX_BYTES is refused rather than stored',
    run: plane.e06SizeCap,
  },
  {
    id: 'e07-external-ingest-fence',
    dimension: 'E2',
    intent:
      'bytes arriving over HTTP are external ingest: with the quarantine seam on they carry a ' +
      'scan stamp, with it off the surface refuses outright (fail closed)',
    run: plane.e07ExternalIngestFence,
  },
  {
    id: 'e08-scan-hook-rejects',
    dimension: 'E2',
    intent: 'a blob a scanner flags is rejected before it can become evidence',
    expectedUnknown:
      'the platform ships only AllowAllScanHook (every asset scans clean); a real scanner is ' +
      'an infra follow-up, so the rejection branch has no HTTP path until one is installed',
    run: plane.e08ScanHookRejects,
  },
  {
    id: 'e09-rejected-stays-rejected',
    dimension: 'E2',
    intent:
      'a rejected upload leaves nothing behind that a re-upload could resurrect — no row, no ' +
      'processor dispatch, no fragment',
    expectedUnknown: 'depends on a scan hook that can reject (see e08)',
    run: plane.e09RejectedStaysRejected,
  },
  {
    id: 'e10-dispatch-terminal',
    dimension: 'E3',
    intent:
      "a pack's declared document→text need reaches a terminal processing run over a clean, " +
      'hot asset, with nothing denied and nothing failed',
    run: plane.e10DispatchTerminal,
  },
  {
    id: 'e11-dispatch-idempotent',
    dimension: 'E3',
    intent:
      're-dispatching the same (asset, capability, processor version) replays the recorded ' +
      'outcome instead of running the adapter again',
    run: plane.e11DispatchIdempotent,
  },
  {
    id: 'e12-undeclared-capability-denied',
    dimension: 'E3',
    intent:
      'a declared need no installed adapter can serve is DENIED with a reason, not silently ' +
      'skipped — the anti-DSL broker must say why it did nothing',
    run: plane.e12UndeclaredCapabilityDenied,
  },
  {
    id: 'e13-failed-run-visible',
    dimension: 'E3',
    intent: 'a failing processor is recorded as failed and an operator can see that it failed',
    expectedUnknown:
      'no read surface exposes processing_run rows; the sweep returns counters in which a ' +
      'failed run is indistinguishable from a succeeded one',
    run: plane.e13FailedRunVisible,
  },
  {
    id: 'e14-fragment-append',
    dimension: 'E4',
    intent:
      'a citation target can be attached to an already-stored blob: re-registering its byteHash ' +
      'dedupes onto the same asset and still appends the requested fragments',
    run: plane.e14FragmentAppend,
  },
  {
    id: 'e15-locator-matrix',
    dimension: 'E4',
    intent:
      'a locator kind that does not apply to the asset modality fails the whole request before ' +
      'a single row is written',
    run: plane.e15LocatorMatrix,
  },
  {
    id: 'e16-fragment-served',
    dimension: 'E4',
    intent: 'fragment text is searchable where the contract says it is (the serving fragment lane)',
    expectedUnknown:
      'the lane (RETRIEVAL_FRAGMENT_LANE) and its citation arm (EVIDENCE_FRAGMENT_CITATIONS) ' +
      'are default-off, and the only reader is a generator call — the one place on this plane ' +
      'that would spend model budget',
    run: plane.e16FragmentServed,
  },
  {
    id: 'e17-fragment-unrolls-to-blob',
    dimension: 'E5',
    intent:
      'THE NORTH STAR — a citation target resolves to the exact bytes it points at, served with ' +
      'the defensive header set',
    run: access.e17FragmentUnrolls,
  },
  {
    id: 'e18-signed-unroll',
    dimension: 'E5',
    intent: 'the same unroll works through a signed URL a third party can redeem without a key',
    run: access.e18SignedUnroll,
  },
  {
    id: 'e19-citation-target-fence',
    dimension: 'E5',
    intent:
      "a fragment unrolls to ITS asset's bytes and nothing else; an unknown target answers a " +
      'bare 404 rather than teaching the id space',
    run: access.e19CitationTargetFence,
  },
  {
    id: 'e20-signed-url-expiry',
    dimension: 'E6',
    intent:
      'a minted URL lives no longer than EVIDENCE_SIGNED_URL_TTL_SECONDS and stops redeeming ' +
      'when it expires',
    run: access.e20SignedUrlExpiry,
  },
  {
    id: 'e21-cross-tenant-refusal',
    dimension: 'E6',
    intent: "one tenant's key can neither stream nor mint over another tenant's asset",
    run: access.e21CrossTenantRefusal,
  },
  {
    id: 'e22-grant-revocation-backstop',
    dimension: 'E6',
    intent:
      'grants gate what they claim to gate: revoking every live grant closes the authenticated ' +
      'read AND kills a URL minted before the revocation',
    run: access.e22GrantRevocationBackstop,
  },
  {
    id: 'e23-signing-secret-not-readable',
    dimension: 'E6',
    intent:
      'the HMAC key that signs raw-evidence URLs is not readable through the operator config ' +
      'viewer — a readable signing key makes every signed URL forgeable',
    run: access.e23SigningSecretNotReadable,
  },
  {
    id: 'e24-orphan-gc-referenced-blob',
    dimension: 'E7',
    intent: 'an orphan sweep never reports a blob a live row still references',
    expectedUnknown:
      'the orphan-blob GC sweep is not in this build (PR #481) — an unreferenced blob is not ' +
      'collected at all today',
    run: access.e24OrphanGcSurface,
  },
];

export const CHECKS_AFTER_FORGET: Check[] = [
  {
    id: 'e25-shared-asset-survives-forget',
    dimension: 'E7',
    intent:
      'an asset a second owner still holds keeps its row, its fragments AND its bytes when the ' +
      'first owner is erased',
    run: access.e25SharedAssetSurvivesForget,
  },
  {
    id: 'e26-shared-blob-drainer',
    dimension: 'E7',
    intent:
      'two asset rows sharing one content-addressed blob must not lose the survivor bytes when ' +
      'one row dies through user-forget',
    expectedUnknown:
      'the defect is real (PR #481 follow-up: the 0114 drainer deletes a queued ref ' +
      'unconditionally) but its precondition cannot be built over HTTP — byteHash is UNIQUE ' +
      'per tenant and the upload path derives storageRef from the hash',
    run: access.e26SharedBlobDrainer,
  },
  {
    id: 'e27-forget-erases-user-evidence',
    dimension: 'E8',
    intent:
      "user-forget destroys the user's sole-owned assets, their fragments, their derived " +
      'representations and their grants — and the citation targets stop resolving',
    run: access.e27ForgetErasesUserEvidence,
  },
  {
    id: 'e28-co-owner-grant-survives',
    dimension: 'E8',
    intent:
      "the erased user's ownership row is gone while the co-owner's is untouched — erasure is " +
      'per-principal, not per-asset',
    run: access.e28CoOwnerGrantSurvives,
  },
  {
    id: 'e29-co-tenant-bytes-survive',
    dimension: 'E8',
    intent:
      "a second tenant holding byte-identical content is unaffected by the first tenant's " +
      'erasure — content addressing must not cross the tenant fence',
    run: access.e29CoTenantBytesSurvive,
  },
];

export const ALL_CHECKS: Check[] = [...CHECKS_BEFORE_FORGET, ...CHECKS_AFTER_FORGET];
