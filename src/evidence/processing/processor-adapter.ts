import type { Readable } from 'node:stream';
import type { DerivedRepresentationKind, EvidenceModality } from '../../common/evidence-taxonomy';
import type { FragmentLocator } from '../locator';

/**
 * ProcessorAdapter — the platform-side contract of the trusted processor
 * broker (Brain v2.1 MM-1, migration 0121).
 *
 * ANTI-DSL DOCTRINE (manifest.ts already forbids the alternative):
 * adapters are PLATFORM code registered in evidence.module.ts; a pack can
 * only DECLARE `memoryModel.processors` needs — no pack-supplied
 * endpoint, model, prompt, module, or code is EVER consulted. The broker
 * matches declared `produces` kinds against installed adapters and
 * nothing else. Real ASR/OCR/vision adapters are follow-ups behind their
 * own keys; this PR ships two deterministic no-network adapters only.
 */

/** What an adapter sees of the asset — metadata plus an optional stream. */
export interface ProcessorAssetSnapshot {
  id: unknown;
  modality: EvidenceModality;
  mediaType: string;
  availability: string;
  byteLength: number;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  pageCount?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface ProcessorInput {
  asset: ProcessorAssetSnapshot;
  /** Present only when availability==='hot' and the storageRef scheme has
   *  a registered storage adapter; null otherwise. */
  openStream: (() => Promise<Readable>) | null;
}

/** One derived output; written as a derived_representation row with
 *  producerVersion = adapter.version and producedByRun = the run id. */
export interface ProcessorOutput {
  kind: DerivedRepresentationKind;
  content?: string | undefined;
  confidence?: number | undefined;
  lang?: string | undefined;
  /**
   * WHERE IN THE ASSET this output describes — a page region, a time
   * range, a char span (the 0109 FragmentLocator union, validated
   * against the asset's modality at the write seam).
   *
   * Present ⇒ writeOutputs creates (or REUSES, by locator identity) the
   * evidence_fragment for that span FIRST and attaches the
   * representation to it (`subjectKind: 'fragment'`). That is the ONLY
   * shape the serving fragment lane can return — the lane filters
   * `subjectKind = 'fragment'`, so an asset-level row is invisible to
   * retrieval however good the adapter is.
   *
   * Absent ⇒ today's asset-level row, byte-identical: an adapter that
   * genuinely describes the WHOLE asset (the text passthrough) states
   * that by emitting no locator, and its rows are unchanged.
   */
  locator?: FragmentLocator | undefined;
  /** Human label for the fragment a `locator` creates (redacted +
   *  capped at the write seam). Ignored without a locator. */
  label?: string | undefined;
}

export interface ProcessorAdapter {
  /** The representation kind this platform processor produces. */
  readonly capability: DerivedRepresentationKind;
  /** Rides producerVersion + the idempotency key
   *  (e.g. 'text-extraction-passthrough-v1'). */
  readonly version: string;
  /** Extra fingerprint parts beyond cap|ver — ONLY knobs that can affect
   *  output (the #386 fingerprint discipline); [] for knobless adapters. */
  configParts(): string[];
  /** Whether this adapter can process the given modality + media type. */
  accepts(modality: EvidenceModality, mediaType: string): boolean;
  process(input: ProcessorInput): Promise<ProcessorOutput[]>;
}

/**
 * DI token for the installed-adapter registry: a readonly array assembled
 * in evidence.module.ts (first matching adapter wins at dispatch).
 * Injected (not imported) so tests can hand the broker stub adapters and
 * future adapters register without touching consumers.
 */
export const EVIDENCE_PROCESSOR_ADAPTERS = Symbol('EVIDENCE_PROCESSOR_ADAPTERS');

export type ProcessorAdapterRegistry = readonly ProcessorAdapter[];
