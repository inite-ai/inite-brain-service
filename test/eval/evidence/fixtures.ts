/**
 * Corpus of the evidence battery: two run-scoped pack manifests and the
 * byte payloads the checks upload.
 *
 * WHY A PACK AT ALL. The evidence plane is gated on pack DECLARATIONS,
 * not just on flags — the processor broker dispatches only capabilities a
 * pack's `memoryModel.processors` asked for, and the raw-read gateway
 * serves bytes only for a tenant holding current consent to a pack that
 * declares `memoryModel.rawEvidence.serve`. No installable pack supplies
 * that today: five builtins omit rawEvidence on purpose (omission =
 * deny), and the one that declares it (`real_estate`) is a BUILTIN, so it
 * never writes the `domain_pack` row the consent fold reads. The battery
 * must therefore bring its own declaration or measure an unreachable
 * surface. The probe pack is that fixture, installed per run under a
 * run-scoped id so two runs never share consent state.
 *
 * The deny pack is its negative twin: same modality, a capability
 * (`document → caption`) that NO installed adapter serves, and no
 * rawEvidence at all. Dispatching it must be DENIED with a reason, which
 * is how E3 measures that an undeclared/unservable need fails loudly
 * instead of silently doing nothing.
 *
 * The payloads are deliberately boring: `text/plain` documents, because
 * `text-extraction-passthrough.adapter.ts` turns them into a derived
 * `text` representation with no model call — the whole battery costs zero
 * model spend, which is what lets it run on a stand with a dummy key.
 */
import { createHash } from 'node:crypto';

/** Minimal valid predicate — a pack must declare at least one. */
const PROBE_PREDICATE = {
  localId: 'observation_note',
  displayLabel: 'observation note',
  description: 'A note attached to an observation by the evidence battery.',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
} as const;

/**
 * The pack that opens the plane: declares the `document` modality, the
 * `document → text` processor need the platform's passthrough adapter can
 * serve, and the raw-evidence capability the read gateway demands.
 */
export function probePackManifest(runId: string): Record<string, unknown> {
  return {
    id: `evev_probe_${runId}`,
    version: '1.0.0',
    description: 'Evidence battery probe pack: document text processing + raw-evidence serving.',
    predicates: [PROBE_PREDICATE],
    memoryModel: {
      modalities: ['text', 'document'],
      processors: [{ id: 'document_text', modality: 'document', produces: ['text'] }],
      rawEvidence: { serve: true },
    },
  };
}

/**
 * The negative twin: a declared need no adapter can satisfy for this
 * modality. Carries NO rawEvidence, so installing it cannot accidentally
 * grant the consent the read checks are measuring.
 */
export function denyPackManifest(runId: string): Record<string, unknown> {
  return {
    id: `evev_deny_${runId}`,
    version: '1.0.0',
    description: 'Evidence battery deny pack: declares a capability no installed adapter serves.',
    predicates: [PROBE_PREDICATE],
    memoryModel: {
      modalities: ['document'],
      processors: [{ id: 'document_caption', modality: 'document', produces: ['caption'] }],
    },
  };
}

/**
 * The primary document. Run-scoped so its sha256 — and therefore the
 * 0109 asset identity and the `fs://<tenant>/<hash>` storage ref — is
 * unique to this run: a re-run on the same tenant must not dedupe onto
 * the previous run's row (the #456 hermeticity doctrine, applied to
 * content-addressed bytes instead of to a userId).
 */
export function primaryDocument(runId: string): Buffer {
  return Buffer.from(
    [
      `# evidence battery ${runId}`,
      '',
      'The quick brown fox jumps over the lazy dog.',
      'Fragment anchor: the invoice total was 4217 EUR on 2026-03-11.',
      'Second paragraph exists so a charRange locator has something to point at.',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** A distinct document — the destructive grant checks need their own. */
export function spareDocument(runId: string): Buffer {
  return Buffer.from(`spare observation for run ${runId}\nrevocation subject\n`, 'utf8');
}

/** Sole-owned by the forget subject: the asset GDPR erasure must destroy. */
export function soleDocument(runId: string): Buffer {
  return Buffer.from(`sole-owned observation for run ${runId}\n`, 'utf8');
}

/** Co-owned: erasing one owner must leave this asset and its bytes whole. */
export function sharedDocument(runId: string): Buffer {
  return Buffer.from(`co-owned observation for run ${runId}\n`, 'utf8');
}

/** The 68-character EICAR body, assembled at runtime so the literal never
 *  sits contiguously in this repo's source (a checked-in EICAR string
 *  trips scanners on developer machines and in CI artifact upload). */
function eicarBody(): string {
  const head = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}';
  const body = '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!';
  return `${head}${body}$H+H*`;
}

/** Whitespace the EICAR spec permits after the body, keyed to the run. */
const EICAR_WHITESPACE = [' ', '\t', '\r', '\n'] as const;
/** 68 body chars + 60 padding = 128, the spec's ceiling. */
const EICAR_PAD = 60;

/**
 * The EICAR anti-malware test file — the industry-standard payload every
 * real scanner is required to flag, and inert as a file. Uploading it is
 * how the battery ASKS the stand whether a real scan hook is installed
 * instead of assuming the answer: a 'clean' verdict on these bytes is the
 * observation that the platform still ships the allow-all stub, which is
 * what gap-gates the quarantine-rejection checks.
 *
 * RUN-SCOPED, and it has to be. The standard body is a fixed 68 bytes, so
 * a second run on the same tenant would re-register a byteHash the first
 * run already owns and get the dedup 409 instead of a scan verdict —
 * measured, on the second run of the very first stand this battery was
 * built against. The spec explicitly allows the body to be followed by
 * whitespace up to 128 characters total, so the padding carries the run
 * salt: still a conforming EICAR file that any real scanner flags, and a
 * distinct content address per run.
 */
export function eicarProbe(runId: string): Buffer {
  const digest = createHash('sha256').update(runId).digest();
  let pad = '';
  for (let i = 0; i < EICAR_PAD; i += 1) {
    pad += EICAR_WHITESPACE[(digest[i % digest.length] ?? 0) % EICAR_WHITESPACE.length];
  }
  return Buffer.from(`${eicarBody()}${pad}`, 'utf8');
}

/** A blob guaranteed to exceed a (small) declared EVIDENCE_MAX_BYTES. */
export function oversizeDocument(capBytes: number): Buffer {
  return Buffer.alloc(capBytes + 1024, 0x61);
}

/** Multipart text parts shared by every upload the battery performs. */
export function uploadFields(opts: {
  userId: string;
  runId: string;
  packId?: string | undefined;
}): {
  modality: string;
  occurredAt: string;
  vertical: string;
  userId: string;
  piiClasses: string;
  recorder: string;
  packId?: string;
} {
  return {
    modality: 'document',
    occurredAt: new Date().toISOString(),
    vertical: 'evidence_eval',
    userId: opts.userId,
    // '' means "a classifier looked and found nothing" — the ONLY value
    // that opens the media-PII gate without brain:read_media. Absent
    // would mean unclassified, which fails closed and would make every
    // read check skip for the wrong reason.
    piiClasses: '',
    recorder: `evidence-battery-${opts.runId}`,
    ...(opts.packId !== undefined ? { packId: opts.packId } : {}),
  };
}
