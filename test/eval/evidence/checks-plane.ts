/**
 * E1–E4: the write half of the evidence plane — what happens between a
 * caller handing over bytes and those bytes becoming a citable fragment.
 *
 * Every assertion here is a status code, a hash comparison or a counter
 * off a documented response shape; nothing consults a model, and nothing
 * reaches into the database. If a check cannot run because a knob is off,
 * a route is dark or a fixture failed to install, it returns `skipped`
 * with the OBSERVED reason — the gap-gating doctrine of
 * `eval:code-memory`, applied to capabilities instead of to pack
 * ontology.
 */
import type { Ctx } from './context';
import { Findings, expectOneOf, expectStatus, knob, knobOn } from './context';
import { eicarProbe, oversizeDocument, primaryDocument, uploadFields } from './fixtures';
import type { Verdict } from './types';
import { fail, pass, skip } from './types';
import { arr, bool, call, num, sha256, str, upload } from './wire';

/** Above this the size-cap probe would push real megabytes over the wire. */
const SIZE_PROBE_CEILING = 4 * 1024 * 1024;

// ── E1 · ingest & identity ──────────────────────────────────────────

export function e01BlobUpload(ctx: Ctx): Verdict {
  const asset = ctx.stand.primary;
  if (!asset) {
    return fail(
      `the primary blob upload did not produce an asset (HTTP ${ctx.stand.primaryUploadStatus})`,
    );
  }
  const f = new Findings();
  f.ok(
    ctx.stand.primaryUploadStatus === 201 || ctx.stand.primaryUploadStatus === 200,
    `upload accepted (HTTP ${ctx.stand.primaryUploadStatus})`,
    `upload answered HTTP ${ctx.stand.primaryUploadStatus}`,
  );
  f.ok(
    asset.byteHash === sha256(asset.bytes),
    'byteHash is the sha256 the server measured over the received bytes',
    `byteHash ${asset.byteHash} != sha256(sent bytes) ${sha256(asset.bytes)}`,
  );
  f.ok(
    asset.availability === 'hot',
    "availability derived 'hot'",
    `availability '${asset.availability}', expected 'hot'`,
  );
  f.ok(
    asset.deduped === false,
    'first registration is not a dedup',
    'a fresh run-scoped payload reported deduped=true',
  );
  f.ok(
    asset.storageRef.startsWith(`fs://${ctx.wire.companyId}/`),
    `storageRef is tenant-scoped (${asset.storageRef})`,
    `storageRef '${asset.storageRef}' is not tenant-scoped under fs://${ctx.wire.companyId}/`,
  );
  return f.verdict();
}

export async function e02ContentDedup(ctx: Ctx): Promise<Verdict> {
  const asset = ctx.stand.primary;
  if (!asset) return skip('no primary asset — the first upload failed');
  const res = await upload(
    ctx.wire,
    { data: asset.bytes, filename: 'primary.txt', contentType: 'text/plain' },
    uploadFields({ userId: ctx.ownerUserId, runId: ctx.runId }),
  );
  if (res.status !== 200 && res.status !== 201) {
    return fail(`re-upload of identical bytes answered HTTP ${res.status} — ${res.text}`);
  }
  const f = new Findings();
  f.ok(
    bool(res.json, 'deduped') === true,
    'deduped=true',
    'the second upload reported deduped=false',
  );
  f.ok(
    str(res.json, 'assetId') === asset.assetId,
    'the same content-addressed asset row was returned',
    `a second row appeared: ${String(str(res.json, 'assetId'))} != ${asset.assetId}`,
  );
  f.ok(
    str(res.json, 'byteHash') === asset.byteHash,
    'one blob, one identity',
    'the dedup path returned a different byteHash',
  );
  return f.verdict();
}

export async function e03DedupProbeClosed(ctx: Ctx): Promise<Verdict> {
  const asset = ctx.stand.primary;
  if (!asset) return skip('no primary asset — the first upload failed');
  const res = await upload(
    ctx.wire,
    { data: asset.bytes, filename: 'probe.txt', contentType: 'text/plain' },
    uploadFields({ userId: `${ctx.ownerUserId}-stranger`, runId: ctx.runId }),
  );
  if (res.status !== 409) {
    return fail(
      `a foreign principal re-registering a known byteHash got HTTP ${res.status}, expected 409 — ${res.text}`,
    );
  }
  const leaked = [asset.assetId, asset.storageRef, ctx.ownerUserId].filter((secret) =>
    res.text.includes(secret),
  );
  if (leaked.length > 0) {
    return fail(`the 409 body leaked stored-row metadata: ${leaked.join(', ')}`);
  }
  return pass('409 with no stored-row metadata — the dedup-probe oracle stays closed');
}

export async function e04EmptyPartRejected(ctx: Ctx): Promise<Verdict> {
  const res = await upload(
    ctx.wire,
    { data: Buffer.alloc(0), filename: 'empty.txt', contentType: 'text/plain' },
    uploadFields({ userId: ctx.ownerUserId, runId: ctx.runId }),
  );
  return expectStatus(res, 400, 'empty file part');
}

export async function e05MediaTypeMatrix(ctx: Ctx): Promise<Verdict> {
  const res = await upload(
    ctx.wire,
    {
      data: primaryDocument(`${ctx.runId}-mismatch`),
      filename: 'x.txt',
      contentType: 'text/plain',
    },
    { ...uploadFields({ userId: ctx.ownerUserId, runId: ctx.runId }), modality: 'image' },
  );
  if (res.status !== 400) {
    return fail(
      `text/plain bytes declared as modality 'image' answered HTTP ${res.status}, expected 400 — ${res.text}`,
    );
  }
  return pass(`(modality, mediaType) pairing refused: ${res.text}`);
}

export async function e06SizeCap(ctx: Ctx): Promise<Verdict> {
  const raw = knob(ctx, 'EVIDENCE_MAX_BYTES');
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap <= 0) {
    return skip(`EVIDENCE_MAX_BYTES reads '${raw}' — no probeable cap`);
  }
  if (cap > SIZE_PROBE_CEILING) {
    return skip(
      `EVIDENCE_MAX_BYTES is ${cap}; probing it would push ${cap + 1024} bytes over the wire ` +
        `(ceiling ${SIZE_PROBE_CEILING}). Lower the knob on the stand to measure this.`,
    );
  }
  const res = await upload(
    ctx.wire,
    { data: oversizeDocument(cap), filename: 'big.txt', contentType: 'text/plain' },
    uploadFields({ userId: ctx.ownerUserId, runId: ctx.runId }),
  );
  return expectOneOf(res, [400, 413], `blob of ${cap + 1024} bytes over a ${cap}-byte cap`);
}

// ── E2 · quarantine ─────────────────────────────────────────────────

export function e07ExternalIngestFence(ctx: Ctx): Verdict {
  const on = knobOn(ctx, 'EVIDENCE_QUARANTINE');
  if (!on) {
    // Fail closed: bytes over HTTP are external ingest by definition, and
    // the write seam must refuse them outright without the scan seam.
    return ctx.stand.primaryUploadStatus === 503
      ? pass('EVIDENCE_QUARANTINE off and the byte surface refused 503 — no external bytes entered')
      : fail(
          `EVIDENCE_QUARANTINE off but the upload answered HTTP ${ctx.stand.primaryUploadStatus} ` +
            '— external bytes entered without the scan seam',
        );
  }
  const stamp = ctx.stand.primaryQuarantineStatus;
  if (stamp === 'clean' || stamp === 'scanning') {
    return pass(`quarantine seam stamped the upload '${stamp}'`);
  }
  return fail(
    `EVIDENCE_QUARANTINE on but the upload reported quarantineStatus ${JSON.stringify(stamp)} ` +
      "— expected 'clean' or 'scanning'",
  );
}

export async function e08ScanHookRejects(ctx: Ctx): Promise<Verdict> {
  if (!knobOn(ctx, 'EVIDENCE_QUARANTINE')) return skip('EVIDENCE_QUARANTINE is off');
  const res = await upload(
    ctx.wire,
    { data: eicarProbe(ctx.runId), filename: 'probe.txt', contentType: 'text/plain' },
    uploadFields({ userId: `${ctx.ownerUserId}-scan`, runId: ctx.runId }),
  );
  if (res.status === 422) {
    return pass('the scan hook rejected the EICAR test string — a real scanner is installed');
  }
  if (res.status === 200 || res.status === 201) {
    const stamp = str(res.json, 'quarantineStatus') ?? '(absent)';
    return skip(
      `the stand cleared the EICAR test string (quarantineStatus '${stamp}') — the platform ` +
        'still ships the allow-all scan stub, so no upload can reach the rejected branch',
    );
  }
  return fail(
    `the EICAR upload answered HTTP ${res.status}, expected 422 or a clean pass — ${res.text}`,
  );
}

export async function e09RejectedStaysRejected(ctx: Ctx): Promise<Verdict> {
  if (!knobOn(ctx, 'EVIDENCE_QUARANTINE')) return skip('EVIDENCE_QUARANTINE is off');
  const first = await upload(
    ctx.wire,
    { data: eicarProbe(ctx.runId), filename: 'probe.txt', contentType: 'text/plain' },
    uploadFields({ userId: `${ctx.ownerUserId}-scan`, runId: ctx.runId }),
  );
  if (first.status !== 422) {
    return skip(
      'no upload reaches a rejected verdict on this stand (see the scan-hook check) — a ' +
        'rejected asset cannot be observed, so "never becomes a fragment" is unmeasurable here',
    );
  }
  const second = await upload(
    ctx.wire,
    { data: eicarProbe(ctx.runId), filename: 'probe.txt', contentType: 'text/plain' },
    uploadFields({ userId: `${ctx.ownerUserId}-scan`, runId: ctx.runId }),
  );
  return expectStatus(second, 422, 're-upload of rejected bytes');
}

// ── E3 · processing ─────────────────────────────────────────────────

/** POST the operator dispatch sweep for one pack over one asset. */
async function dispatch(
  ctx: Ctx,
  target: { packId: string; assetId: string },
): Promise<{ status: number; text: string; counts: Record<string, number> }> {
  const res = await call(ctx.wire, {
    method: 'POST',
    path: '/v1/admin/maintenance/evidence/dispatch',
    body: { packId: target.packId, assetId: target.assetId },
  });
  const counts: Record<string, number> = {};
  for (const key of ['assets', 'dispatched', 'runs', 'denied', 'failed']) {
    counts[key] = num(res.json, key) ?? -1;
  }
  return { status: res.status, text: res.text, counts };
}

export async function e10DispatchTerminal(ctx: Ctx): Promise<Verdict> {
  const { packId } = ctx.gates;
  const asset = ctx.stand.primary;
  if (packId === null) return skip(`probe pack not installed: ${ctx.gates.packError ?? 'unknown'}`);
  if (!asset) return skip('no primary asset — the first upload failed');
  if (!knobOn(ctx, 'EVIDENCE_PROCESSOR_BROKER')) return skip('EVIDENCE_PROCESSOR_BROKER is off');
  const out = await dispatch(ctx, { packId, assetId: asset.assetId });
  if (out.status !== 200 && out.status !== 201) {
    return fail(`dispatch answered HTTP ${out.status} — ${out.text}`);
  }
  ctx.stand.firstDispatch = out.counts;
  const f = new Findings();
  f.ok(
    out.counts.assets === 1,
    'the targeted sweep considered exactly the named asset',
    `assets=${out.counts.assets}`,
  );
  f.ok(out.counts.dispatched === 1, 'dispatch completed', `dispatched=${out.counts.dispatched}`);
  f.ok(
    (out.counts.runs ?? 0) >= 1,
    `runs=${out.counts.runs}`,
    'the declared document→text need produced no processing run',
  );
  f.ok(out.counts.denied === 0, 'nothing denied', `denied=${out.counts.denied}`);
  f.ok(out.counts.failed === 0, 'nothing failed', `failed=${out.counts.failed}`);
  return f.verdict();
}

export async function e11DispatchIdempotent(ctx: Ctx): Promise<Verdict> {
  const { packId } = ctx.gates;
  const asset = ctx.stand.primary;
  const first = ctx.stand.firstDispatch;
  if (packId === null || !asset || first === null) return skip('the first dispatch did not run');
  const out = await dispatch(ctx, { packId, assetId: asset.assetId });
  if (out.status !== 200 && out.status !== 201) {
    return fail(`the replay dispatch answered HTTP ${out.status} — ${out.text}`);
  }
  const drift = ['runs', 'denied', 'failed'].filter((k) => out.counts[k] !== first[k]);
  if (drift.length > 0) {
    return fail(
      `replay is not idempotent — ${drift
        .map((k) => `${k}: ${first[k]} then ${out.counts[k]}`)
        .join(', ')}`,
    );
  }
  return pass(`replay returned the recorded outcome unchanged (runs=${out.counts.runs}, failed=0)`);
}

export async function e12UndeclaredCapabilityDenied(ctx: Ctx): Promise<Verdict> {
  const { denyPackId } = ctx.gates;
  const asset = ctx.stand.primary;
  if (denyPackId === null) return skip('the deny pack could not be installed');
  if (!asset) return skip('no primary asset — the first upload failed');
  const out = await dispatch(ctx, { packId: denyPackId, assetId: asset.assetId });
  if (out.status !== 200 && out.status !== 201) {
    return fail(`dispatch answered HTTP ${out.status} — ${out.text}`);
  }
  const f = new Findings();
  f.ok(
    (out.counts.denied ?? 0) >= 1,
    `the unservable document→caption need was denied (denied=${out.counts.denied})`,
    'a capability no installed adapter serves produced no denial — the gate is silent',
  );
  f.ok(out.counts.runs === 0, 'no run was created', `runs=${out.counts.runs}, expected 0`);
  return f.verdict();
}

export function e13FailedRunVisible(): Verdict {
  return skip(
    'no read surface exposes processing_run rows: 0121 ships the lifecycle but no admin list ' +
      'route, and POST /v1/admin/maintenance/evidence/dispatch answers with counters only ' +
      '(assets/dispatched/runs/denied/failed), where a failed run is indistinguishable from a ' +
      'succeeded one. "Recorded as failed, not silently dropped" is therefore unobservable over HTTP.',
  );
}

// ── E4 · fragments ──────────────────────────────────────────────────

export function e14FragmentAppend(ctx: Ctx): Verdict {
  const asset = ctx.stand.primary;
  if (!asset) return skip('no primary asset — the first upload failed');
  if (!knobOn(ctx, 'EVIDENCE_INGEST_ENABLED')) return skip('EVIDENCE_INGEST_ENABLED is off');
  if (asset.fragmentId === null) {
    return fail('registering the primary byteHash with fragments produced no fragment id');
  }
  return pass(`fragment ${asset.fragmentId} appended to the deduped asset ${asset.assetId}`);
}

export async function e15LocatorMatrix(ctx: Ctx): Promise<Verdict> {
  const asset = ctx.stand.primary;
  if (!asset) return skip('no primary asset — the first upload failed');
  if (!knobOn(ctx, 'EVIDENCE_INGEST_ENABLED')) return skip('EVIDENCE_INGEST_ENABLED is off');
  const res = await call(ctx.wire, {
    method: 'POST',
    path: '/v1/ingest/evidence-asset',
    body: {
      modality: 'image',
      mediaType: 'image/png',
      byteHash: asset.byteHash,
      byteLength: asset.bytes.byteLength,
      occurredAt: new Date().toISOString(),
      originUri: `https://example.invalid/${ctx.runId}`,
      vertical: 'evidence_eval',
      userId: ctx.ownerUserId,
      piiClasses: [],
      fragments: [{ locator: { kind: 'charRange', start: 0, end: 8 } }],
    },
  });
  if (res.status !== 400) {
    return fail(
      `a charRange locator on an image answered HTTP ${res.status}, expected 400 — ${res.text}`,
    );
  }
  if (!res.text.includes('fragments[0].locator')) {
    return fail(`400 raised, but not by the locator matrix: ${res.text}`);
  }
  return pass('charRange on modality image refused before any row was written');
}

export async function e16FragmentServed(ctx: Ctx): Promise<Verdict> {
  const lane = knobOn(ctx, 'RETRIEVAL_FRAGMENT_LANE');
  const cites = knobOn(ctx, 'EVIDENCE_FRAGMENT_CITATIONS');
  if (!lane || !cites) {
    return skip(
      `RETRIEVAL_FRAGMENT_LANE=${knob(ctx, 'RETRIEVAL_FRAGMENT_LANE')}, ` +
        `EVIDENCE_FRAGMENT_CITATIONS=${knob(ctx, 'EVIDENCE_FRAGMENT_CITATIONS')} — ` +
        'no serving reader of fragments is enabled on this stand',
    );
  }
  if (!ctx.allowSynthesize) {
    return skip(
      'the only reader of fragment text is the synthesize fragment lane, which spends model ' +
        'budget; set EVEV_ALLOW_SYNTHESIZE=1 to measure it',
    );
  }
  const res = await call(ctx.wire, {
    method: 'POST',
    path: '/v1/synthesize',
    body: { query: 'what was the invoice total', limit: 10, userId: ctx.ownerUserId },
  });
  const citations = arr(res.json, 'evidenceCitations');
  const mine = citations.filter((c) => str(c, 'assetId') === ctx.stand.primary?.assetId);
  return mine.length > 0
    ? pass(`the served answer cited ${mine.length} fragment(s) of the seeded asset`)
    : fail(
        `no fragment-arm citation named the seeded asset (${citations.length} citations) — ${res.text}`,
      );
}
