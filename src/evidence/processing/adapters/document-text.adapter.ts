import { Injectable } from '@nestjs/common';
import PDFParser, { type Output, type Page, type Text } from 'pdf2json';
import { evidenceDerivedMaxBytes, evidenceMaxBytes } from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes, withDeadline } from './adapter-io';

/**
 * DocumentTextAdapter — real per-page text extraction from PDFs, the
 * second byte-reading platform processor on the multimodal plane and the
 * counterpart to TextExtractionPassthroughAdapter (which only ever echoed
 * already-plain-text documents back). Same capability ('text'), disjoint
 * media types: the passthrough owns `text/*` + JSON, this owns PDF, so
 * the broker's first-match dispatch is unambiguous either way.
 *
 * Engine: pdf2json (Apache-2.0, ZERO runtime dependencies, pure
 * JavaScript, no native build, no headless browser). It is a
 * self-contained CommonJS bundle, which is what makes it usable here at
 * all — the modern pdf.js distributions (pdfjs-dist, unpdf) are ESM-only
 * and reach their engine through a dynamic import, which Jest's CJS
 * runtime cannot service without --experimental-vm-modules. Choosing an
 * engine we can actually unit-test against real bytes beat choosing the
 * newer one and testing it against a mock. See the PR for the full
 * comparison.
 *
 * Everything is local: no network, no model, no key. Deterministic — the
 * same bytes always produce the same string.
 *
 * PER-PAGE LOCATORS. The extractor is page-structured internally
 * (extractPages returns one entry per page, in page order), but
 * ProcessorOutput on this branch carries no `locator` field, so N
 * page-level outputs would land as N indistinguishable
 * derived_representation rows of the same (subject, kind). Until the
 * locator field merges, the adapter therefore emits ONE asset-level
 * output whose content carries deterministic `[page i of n]` markers;
 * switching to true per-page outputs afterwards is a change to
 * `process()` alone.
 *
 * A PDF with no text layer (a pure scan) FAILS the run with a message
 * that names the missing capability rather than writing an empty
 * representation — silence would look like "this document says nothing".
 */
@Injectable()
export class DocumentTextAdapter implements ProcessorAdapter {
  readonly capability = 'text' as const;
  readonly version = 'document-pdf-text-v1';

  /**
   * The page-marker + line-assembly contract is the knob that moves
   * output without moving the code version: retune the geometry and
   * every stored representation is stale under an unchanged idempotency
   * key. Riding it in the fingerprint forks the key automatically
   * (#386 discipline). The parse DEADLINE deliberately does not ride it —
   * a timeout is a run failure, not a different output.
   */
  configParts(): string[] {
    return [`render=${PAGE_RENDER_CONTRACT}`];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (modality !== 'document') return false;
    return PDF_MEDIA_TYPES.has(normaliseMediaType(mediaType));
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const pages = await extractPages(bytes);
    if (pages.every((page) => page === '')) {
      throw new Error(
        `PDF carries no extractable text layer (${String(pages.length)} pages) — ` +
          'a scanned document needs an OCR processor, not text extraction',
      );
    }
    const content = renderPages(pages);
    // Reject, never truncate: a silently clipped document would read as a
    // complete one. The run service enforces the same cap; failing here
    // names the document that broke it.
    const cap = evidenceDerivedMaxBytes();
    if (Buffer.byteLength(content, 'utf8') > cap) {
      throw new Error(
        `extracted text of ${String(pages.length)} pages exceeds the ` +
          `derived-output cap (${String(cap)} bytes)`,
      );
    }
    return [{ kind: 'text', content }];
  }
}

/**
 * Identifier of the rendering contract (page markers + line assembly).
 * Bump it whenever the geometry constants or the marker shape below
 * change — that is what forks the idempotency key.
 */
const PAGE_RENDER_CONTRACT = 'page-marked-v1';

/** Wall-clock bound on one parse; a crafted PDF must not hang a worker. */
const PDF_PARSE_DEADLINE_MS = 30_000;

/** pdf2json verbosity: -1 silences even its error dump (we surface the
 *  error ourselves, PII-redacted, through the run row). */
const PDF_VERBOSITY_SILENT = -1;

const PDF_MEDIA_TYPES = new Set(['application/pdf', 'application/x-pdf']);

/**
 * pdf2json reports text positions in page units of 16 PDF points (a
 * 612pt-wide page comes back as 38.25 units) while `Text.w` stays in raw
 * points — so a width must be divided by this before it can be compared
 * with an x coordinate.
 */
const POINTS_PER_UNIT = 16;

/** Rows whose y differs by less than this are one visual line (0.2 units
 *  = 3.2pt, comfortably under the leading of even a 6pt font). */
const LINE_TOLERANCE_UNITS = 0.2;

/**
 * White space between two runs that earns a space character (~0.8pt).
 * The rule is "runs that do not touch are separate words": a gap at or
 * below this is kerning or a mid-word style change and must NOT be split
 * (a split word is an out-of-vocabulary token for the BM25 lane, which is
 * worse than a missing space).
 */
const SPACE_GAP_UNITS = 0.05;

/** `application/PDF; version=1.7` → `application/pdf`. */
function normaliseMediaType(mediaType: string): string {
  const semicolon = mediaType.indexOf(';');
  return (semicolon === -1 ? mediaType : mediaType.slice(0, semicolon)).trim().toLowerCase();
}

/** One assembled string per page, in page order. */
async function extractPages(bytes: Buffer): Promise<string[]> {
  const parser = new PDFParser(null, false);
  try {
    const parsed = await withDeadline(parseBuffer(parser, detachFromPool(bytes)), {
      ms: PDF_PARSE_DEADLINE_MS,
      label: 'PDF parse',
      onTimeout: () => {
        parser.destroy();
      },
    });
    return parsed.Pages.map(assemblePage);
  } finally {
    parser.destroy();
  }
}

/**
 * WORKAROUND — pdf2json 4.0.3 cross-document contamination.
 *
 * `PDFParser.parseBuffer` normalises its input with
 * `Buffer.from(buf.buffer, 0, buf.byteLength)` whenever the Buffer is a
 * VIEW into a larger ArrayBuffer. That rebuild starts at offset 0 and
 * IGNORES `byteOffset`, so a pooled Buffer (which is what
 * `Buffer.concat` / `Buffer.allocUnsafe` return for anything under
 * Node's 8 KiB pool threshold — i.e. every small PDF we read off a
 * stream) is re-read from the wrong slice of the shared pool. Observed
 * consequences, both silent: an "Invalid XRef stream" failure, and — far
 * worse — the PREVIOUS document's text coming back as this document's
 * content. On an evidence plane that is one asset's bytes attributed to
 * another asset's lineage, so it is fixed here rather than tolerated.
 *
 * `Buffer.alloc` never draws from the pool, so the copy owns its whole
 * ArrayBuffer and pdf2json's rebuild becomes a no-op. Buffers that
 * already own theirs are passed through untouched.
 */
function detachFromPool(bytes: Buffer): Buffer {
  if (bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength) return bytes;
  const owned = Buffer.alloc(bytes.byteLength);
  bytes.copy(owned);
  return owned;
}

/** Promisify pdf2json's event pair; a parse error becomes a real Error. */
function parseBuffer(parser: PDFParser, bytes: Buffer): Promise<Output> {
  return new Promise<Output>((resolve, reject) => {
    parser.on('pdfParser_dataReady', resolve);
    parser.on('pdfParser_dataError', (raw) => {
      const err = raw instanceof Error ? raw : raw.parserError;
      reject(err instanceof Error ? err : new Error(`PDF parse failed: ${String(err)}`));
    });
    try {
      parser.parseBuffer(bytes, PDF_VERBOSITY_SILENT);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Rebuild reading order from positioned runs. pdf2json emits y growing
 * DOWNWARD, so sorting by (y, x) is reading order; runs are then grouped
 * into visual lines and joined by the touch rule above. Content-stream
 * order is deliberately not trusted — it is emission order, which for the
 * same document can put the footer first.
 */
function assemblePage(page: Page): string {
  const runs = (page.Texts ?? [])
    .map(toRun)
    .filter((run): run is PositionedRun => run !== null)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: string[] = [];
  let line = '';
  let lineY: number | null = null;
  let previousEnd = 0;
  for (const run of runs) {
    if (lineY === null || run.y - lineY > LINE_TOLERANCE_UNITS) {
      if (line !== '') lines.push(line);
      line = run.text;
      lineY = run.y;
    } else {
      line += (run.x - previousEnd > SPACE_GAP_UNITS ? ' ' : '') + run.text;
    }
    previousEnd = run.x + run.w / POINTS_PER_UNIT;
  }
  if (line !== '') lines.push(line);
  return lines.join('\n').trim();
}

interface PositionedRun {
  x: number;
  y: number;
  w: number;
  text: string;
}

/** Decode one pdf2json text item; null when it carries no characters. */
function toRun(item: Text): PositionedRun | null {
  const text = (item.R ?? [])
    .map((run) => decodeRunText(run.T))
    .join('')
    .replace(/\s+/g, ' ');
  if (text.trim() === '') return null;
  return { x: item.x, y: item.y, w: item.w, text };
}

/** pdf2json percent-encodes run text; a malformed escape must not throw. */
function decodeRunText(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Deterministic page markers — `[page i of n]`, the house `[...]` header
 *  shape, one blank line between pages. */
function renderPages(pages: string[]): string {
  const total = pages.length;
  return pages
    .map((text, index) => `[page ${String(index + 1)} of ${String(total)}]\n${text}`.trim())
    .join('\n\n');
}
