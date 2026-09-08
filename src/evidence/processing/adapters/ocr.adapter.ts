import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { OEM, createWorker, type Block, type Worker } from 'tesseract.js';
import {
  evidenceMaxBytes,
  evidenceOcrEnabled,
  evidenceOcrLanguages,
  evidenceOcrMinConfidence,
} from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { FragmentLocator } from '../../locator';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes, withDeadline } from './adapter-io';
import {
  OCR_TESSDATA_VARIANT,
  assertOcrLanguagesLocal,
  ocrLangPath,
  type OcrLanguage,
} from './ocr-assets';

/**
 * OcrAdapter — the third real (byte-reading) platform processor, and the
 * one that makes an IMAGE readable rather than merely described.
 *
 * Before it, a PDF with a text layer was legible (DocumentTextAdapter)
 * and an image yielded only intrinsic facts — format, geometry,
 * allowlisted EXIF (ImageMetadataAdapter). A screenshot of a failing
 * dashboard, a photo of a whiteboard, a scan with no text layer were all
 * MUTE: the plane could store them, cite them, and serve their bytes, but
 * never read a word. This adapter closes that gap and is the reason the
 * pack media contracts have carried an undeclared `ocr` slot.
 *
 * ENGINE: tesseract.js (Apache-2.0) over the tesseract.js-core WASM
 * build. Chosen for the same reason pdf2json was: it is the option we can
 * actually run and TEST under our constraints — a CommonJS package with
 * no native build step, no headless browser, no system binary, and no
 * API key. The alternatives fail at least one: node-tesseract-ocr and
 * tesseract-ocr bindings need a system `tesseract` (a new apt layer and a
 * glibc ABI surface next to the onnxruntime one we already nurse);
 * tesseract-wasm is ESM-only, which Jest's CJS runtime cannot service
 * without --experimental-vm-modules; the ONNX-based detectors (PaddleOCR
 * ports, @gutenye/ocr-node) reintroduce onnxruntime-node, whose
 * unstubbed workers are the documented cause of this repo's CI SIGABRT
 * class. Every hosted OCR API is disqualified outright — paid, and
 * network.
 *
 * NO NETWORK, EVER. tesseract.js is CDN-first by default; ocr-assets.ts
 * documents in full how both halves (WASM core, language models) are
 * pinned to local files, and asserts it before the engine starts. There
 * is no code path in this adapter that can produce a URL.
 *
 * WHAT IT EMITS. One output PER TEXT REGION, each carrying a
 * `pageRegion` locator normalised to [0,1]. The write seam turns each
 * into (or reuses) an evidence_fragment, which is the ONLY shape the
 * serving fragment lane can return — so a claim can cite "this sentence,
 * in this corner of this screenshot" rather than "somewhere in this
 * image". Locator identity is the dedup key, so a re-run under a bumped
 * version re-attaches to the SAME citation target.
 *
 * HONESTY OVER COVERAGE. An OCR engine never says "nothing here": point
 * it at a photo of a wall and it returns confident-looking garbage. Words
 * below EVIDENCE_OCR_MIN_CONFIDENCE are therefore dropped and the drop is
 * STATED in the region's text; a region with nothing left is not written;
 * an image with no surviving region FAILS the run with a message that
 * says so, exactly as DocumentTextAdapter fails a text-layer-less PDF.
 * Silence is a better memory than invention.
 *
 * COST. Bounded on four independent axes — the byte cap
 * (evidenceMaxBytes, enforced while streaming), a pixel cap (the image is
 * downscaled to OCR_MAX_EDGE_PX before recognition, so cost is bounded by
 * area rather than by whatever a caller uploaded), a wall-clock deadline
 * that terminates the engine, and a region cap that refuses (never
 * truncates) an implausibly fragmented page. Recognition itself runs in a
 * worker_thread that tesseract.js spawns and this adapter terminates in a
 * `finally` — the event loop serving requests is never blocked by WASM,
 * and the ~40 MB engine footprint lives only for the duration of one run
 * rather than resident forever in a pool.
 */
@Injectable()
export class OcrAdapter implements ProcessorAdapter {
  readonly capability = 'ocr' as const;
  readonly version = 'image-ocr-tesseract-v1';

  /**
   * Everything that can move the recognised text WITHOUT moving the code
   * version, so that changing any of it forks the idempotency key
   * (#386 discipline) and re-reads instead of leaving stale text behind:
   * the language set (different scripts, different characters), the
   * confidence floor (different words survive), the pixel/greyscale
   * preprocessing contract, the tessdata generation (the model itself),
   * and the region cap (which decides between an output and a failure).
   * The DEADLINES deliberately do not ride it — a timeout is a run
   * failure, not a different output (the adapter-io contract).
   */
  configParts(): string[] {
    return [
      `langs=${evidenceOcrLanguages().join('+')}`,
      `tessdata=${OCR_TESSDATA_VARIANT}`,
      `minConfidence=${String(evidenceOcrMinConfidence())}`,
      `prep=${IMAGE_PREP_CONTRACT}`,
      `maxRegions=${String(OCR_MAX_REGIONS)}`,
    ];
  }

  /**
   * The EVIDENCE_OCR_ENABLED gate lives HERE rather than in the module's
   * registry factory on purpose: a factory read would capture the flag at
   * boot, and this family's contract is that a flip is runtime-mutable.
   * Declining here leaves the broker recording its ordinary
   * `no installed processor` denial, which is precisely what it records
   * today — so an operator who never turns OCR on sees byte-identical
   * behaviour whether or not this adapter is in the registry.
   */
  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (!evidenceOcrEnabled()) return false;
    if (modality !== 'image') return false;
    return OCR_MEDIA_TYPES.has(normaliseMediaType(mediaType));
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const langs = evidenceOcrLanguages();
    // Before a byte is read: refuse an unshipped language, and prove the
    // models are on local disk. A missing model must be a named failure,
    // never a network reach and never a stall.
    assertOcrLanguagesLocal(langs);
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const prepared = await withDeadline(prepareImage(bytes), {
      ms: IMAGE_PREP_DEADLINE_MS,
      label: 'OCR image preparation',
    });
    const blocks = await recognizeBlocks(prepared, langs);
    if (blocks.length > OCR_MAX_REGIONS) {
      // Reject, never truncate: a clipped page would read as a complete
      // one (the DocumentTextAdapter cap precedent). A page this
      // fragmented is also the signature of noise, not of a document.
      throw new Error(
        `image yields ${String(blocks.length)} text regions, above the per-run ` +
          `region cap (${String(OCR_MAX_REGIONS)}) — refusing to store a partial reading`,
      );
    }
    const floor = evidenceOcrMinConfidence();
    const outputs = blocks
      .map((block) => filterBlock(block, floor))
      .filter((region): region is RecognisedRegion => region !== null)
      .map((region, index, all) => toOutput(region, { prepared, langs, index, total: all.length }));
    if (outputs.length === 0) {
      throw new Error(
        'no text recognised above the confidence floor ' +
          `(${String(floor)}/100) — the image carries no legible text`,
      );
    }
    return outputs;
  }
}

/**
 * Identifier of the preprocessing contract (orientation, colour, scale,
 * container). Bump it whenever any of the constants or steps in
 * prepareImage() change — that is what forks the idempotency key.
 */
const IMAGE_PREP_CONTRACT = 'grey-2000px-png-v1';

/**
 * Longest edge handed to the engine. THE cost bound that matters:
 * recognition time is linear in pixel count, and a 48 MP phone photo is
 * ~24x the work of a 2000px render for no accuracy gain (tesseract wants
 * roughly 30px glyph height, which 2000px across delivers for anything
 * legible to a human). Images at or below it are passed through
 * untouched, so the common screenshot case is not resampled at all.
 */
const OCR_MAX_EDGE_PX = 2000;

/**
 * Bound on the number of text regions ONE image may produce. Each region
 * becomes a fragment plus a representation row, so this is the fan-out
 * bound on the write side (the EMBED_OUTPUTS_PER_RUN_MAX rationale in
 * processing-run.service.ts). 64 is generous for a single page — a dense
 * A4 scan segments into a couple of dozen blocks — so exceeding it means
 * the segmenter is chasing texture, not text.
 */
const OCR_MAX_REGIONS = 64;

/** Wall-clock bound on the decode/downscale step (libvips, header-cheap
 *  for the common case). */
const IMAGE_PREP_DEADLINE_MS = 10_000;

/** Wall-clock bound on engine start: WASM instantiation plus a ~3 MB
 *  model read off local disk. Measured at ~0.1s; a second is three
 *  orders of margin, and blowing it means something is very wrong. */
const OCR_ENGINE_START_DEADLINE_MS = 30_000;

/** Wall-clock bound on one recognition pass. A crafted image must not be
 *  able to wedge a worker; the engine is terminated when it fires. */
const OCR_RECOGNIZE_DEADLINE_MS = 30_000;

/**
 * Raster types both libvips and this adapter accept. Deliberately the
 * ImageMetadataAdapter set MINUS `image/svg+xml`: an SVG's text is
 * already text (OCR of a rasterised vector is a lossy round-trip of data
 * we could read directly), and rasterising untrusted SVG hands librsvg a
 * document that can reference external entities — an egress surface this
 * adapter exists to not have. Declining at accepts() time lets the broker
 * record an honest `no installed processor` denial instead of a failed
 * run.
 */
const OCR_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jp2',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

/** `image/JPEG; charset=binary` → `image/jpeg`. */
function normaliseMediaType(mediaType: string): string {
  const semicolon = mediaType.indexOf(';');
  return (semicolon === -1 ? mediaType : mediaType.slice(0, semicolon)).trim().toLowerCase();
}

interface PreparedImage {
  png: Buffer;
  /** Geometry of the PREPARED raster — the frame every bbox is
   *  normalised against. */
  width: number;
  height: number;
}

/**
 * Decode → orient → greyscale → bound → PNG.
 *
 * `failOn: 'error'` makes corrupt bytes an honest throw rather than a
 * best-effort partial decode. `.rotate()` with no argument applies the
 * EXIF orientation tag, so a phone photo held sideways is recognised
 * instead of returning nonsense — locators are consequently expressed in
 * the ORIENTED frame, which is the frame any viewer renders. Greyscale
 * is what the LSTM recogniser consumes internally anyway; doing it here
 * makes the input deterministic and a third of the size. PNG because it
 * is lossless: a JPEG round-trip would introduce ringing around glyph
 * edges, which is exactly the artefact that manufactures low-confidence
 * garbage.
 */
async function prepareImage(bytes: Buffer): Promise<PreparedImage> {
  const pipeline = sharp(bytes, { failOn: 'error' })
    .rotate()
    .greyscale()
    .resize({
      width: OCR_MAX_EDGE_PX,
      height: OCR_MAX_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 1 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  if (info.width < 1 || info.height < 1) {
    throw new Error('image has no pixels to read');
  }
  return { png: data, width: info.width, height: info.height };
}

/**
 * Run one recognition pass in a throwaway tesseract.js worker.
 *
 * WORKER LIFECYCLE. tesseract.js spawns a real `worker_threads` Worker,
 * so the WASM burn happens off the request event loop — which is what
 * makes this safe on the fire-and-forget dispatch path the blob upload
 * uses. It is created per call and terminated in `finally`; a pooled
 * scheduler would amortise the ~0.1 s start-up but hold a thread and the
 * engine's tens of megabytes resident for the entire process lifetime,
 * which is the wrong trade for a capability most tenants never enable.
 *
 * If the START deadline fires we have no handle to terminate yet, so the
 * pending promise is given a terminator to run whenever it does resolve —
 * a timed-out start must not leak a thread.
 */
async function recognizeBlocks(
  prepared: PreparedImage,
  langs: OcrLanguage[],
): Promise<readonly Block[]> {
  const pending = startWorker(langs);
  const worker = await withDeadline(pending, {
    ms: OCR_ENGINE_START_DEADLINE_MS,
    label: 'OCR engine start',
    onTimeout: () => {
      void pending.then((late) => late.terminate()).catch(() => undefined);
    },
  });
  try {
    const result = await withDeadline(
      worker.recognize(prepared.png, {}, { blocks: true, text: false }),
      {
        ms: OCR_RECOGNIZE_DEADLINE_MS,
        label: 'OCR recognition',
        onTimeout: () => {
          void worker.terminate().catch(() => undefined);
        },
      },
    );
    return result.data.blocks ?? [];
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

/**
 * Engine options, every one of them chosen to keep the run local and
 * side-effect free:
 *   * `langPath` — an absolute local directory holding every configured
 *     language's model, which is what puts tesseract.js on its
 *     filesystem branch instead of its CDN branch (ocr-assets.ts);
 *   * `cacheMethod: 'none'` — the default ('write') makes the worker read
 *     AND WRITE `./<lang>.traineddata` relative to the process CWD, i.e.
 *     drop a multi-megabyte file into the working directory of a server
 *     that never asked for one, and then prefer that stale copy forever.
 *     Off. The model is already on local disk; a second copy is pure
 *     liability;
 *   * `gzip: true` — the shipped models are `.traineddata.gz`;
 *   * `logger` silenced — progress callbacks fire hundreds of times per
 *     page and would drown the run log; failures surface through the
 *     thrown error, PII-redacted, on the processing_run row.
 * `corePath` and `workerPath` are deliberately NOT set: in Node both
 * resolve through `require` to the packaged local files, and passing a
 * value would only create a way to get them wrong.
 *
 * WORKAROUND — tesseract.js 7.0.0 swallows start-up failures.
 * `createWorker` ends its own initialisation chain with `.catch(() => {})`
 * (src/createWorker.js), so the promise it returns NEVER rejects: a
 * failed load / loadLanguage / initialize simply leaves it pending
 * forever, and the only report of the failure is a call to the
 * `errorHandler` option. Without the race below, a corrupt model would
 * surface as a 30-second deadline timeout instead of the real message —
 * so the handler is wired to reject, and the resolution is whichever
 * comes first.
 *
 * The residual cost of the same upstream shape: when start-up fails there
 * is no worker handle to terminate (the promise that would have carried
 * it never settles), so that thread is orphaned. Which is precisely why
 * `assertOcrLanguagesLocal` pre-flights every model file before the
 * engine is touched — it makes the realistic failure unreachable rather
 * than merely reported.
 */
function startWorker(langs: OcrLanguage[]): Promise<Worker> {
  return new Promise<Worker>((resolve, reject) => {
    createWorker(langs.join('+'), OEM.LSTM_ONLY, {
      langPath: ocrLangPath(langs),
      cacheMethod: 'none',
      gzip: true,
      logger: () => undefined,
      errorHandler: (error: unknown) => {
        // A no-op after the promise has settled; the only signal before.
        reject(new Error(`OCR engine failed to start: ${String(error)}`));
      },
    }).then(resolve, reject);
  });
}

interface RecognisedRegion {
  text: string;
  /** Mean confidence of the SURVIVING words, 0..100. */
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  droppedWords: number;
}

/**
 * Apply the confidence floor at WORD granularity, then rebuild the
 * region's text from the survivors.
 *
 * Word-level rather than block-level because a floor applied to whole
 * blocks is a false choice: one misread word would discard a paragraph of
 * good text, or one good paragraph would carry a misread word into
 * storage as fact. Filtering words keeps what was actually read and
 * discards what was guessed — and the count of discards is reported to
 * the reader rather than hidden, so a heavily-filtered region is visibly
 * a partial reading.
 */
function filterBlock(block: Block, floor: number): RecognisedRegion | null {
  const lines: string[] = [];
  let confidenceSum = 0;
  let kept = 0;
  let dropped = 0;
  for (const paragraph of block.paragraphs ?? []) {
    for (const line of paragraph.lines ?? []) {
      const words: string[] = [];
      for (const word of line.words ?? []) {
        const text = word.text.trim();
        if (text === '') continue;
        if (word.confidence < floor) {
          dropped++;
          continue;
        }
        words.push(text);
        confidenceSum += word.confidence;
        kept++;
      }
      if (words.length > 0) lines.push(words.join(' '));
    }
  }
  if (kept === 0) return null;
  return {
    text: lines.join('\n'),
    confidence: confidenceSum / kept,
    bbox: block.bbox,
    droppedWords: dropped,
  };
}

/**
 * One region → one fragment-bearing output.
 *
 * The dropped-word notice uses the house `[...]` marker shape
 * (DocumentTextAdapter's `[page i of n]`): a reader — human or generator
 * — must be able to tell a complete reading from a filtered one from the
 * stored content alone, without consulting the run row.
 */
interface RegionContext {
  prepared: PreparedImage;
  langs: OcrLanguage[];
  index: number;
  total: number;
}

function toOutput(region: RecognisedRegion, ctx: RegionContext): ProcessorOutput {
  const notice =
    region.droppedWords === 0
      ? ''
      : `\n[ocr: ${String(region.droppedWords)} low-confidence ` +
        `word${region.droppedWords === 1 ? '' : 's'} dropped]`;
  return {
    kind: 'ocr',
    content: region.text + notice,
    // derived_representation.confidence is a 0..1 float (0109); tesseract
    // scores 0..100. Rounded so an identical re-read stores an identical
    // number rather than a float that differs in its last bits.
    confidence: round(clamp01(region.confidence / 100), CONFIDENCE_DECIMALS),
    lang: ctx.langs.join('+'),
    locator: regionLocator(region.bbox, ctx.prepared),
    label: regionLabel(region.text, ctx),
  };
}

/**
 * Pixel bbox → normalised `pageRegion`.
 *
 * Normalisation is what makes the downscale above invisible to a citing
 * reader: coordinates are fractions of the image, so a locator computed
 * on a 2000px render addresses the same area of the 8000px original, and
 * a future adapter version that picks a different working resolution
 * still lands on the SAME fragment (locator identity is the dedup key).
 *
 * Page 0 because an image has exactly one page (validateLocator enforces
 * it). Coordinates are rounded to a fixed precision — the dedup key is
 * built from `String(value)`, so an unrounded float would fork a new
 * fragment on every re-run — and then re-clamped, because rounding can
 * push x+w a hair over the 1.0 the validator requires.
 */
function regionLocator(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  prepared: PreparedImage,
): FragmentLocator | undefined {
  const x = round(clamp01(bbox.x0 / prepared.width), LOCATOR_DECIMALS);
  const y = round(clamp01(bbox.y0 / prepared.height), LOCATOR_DECIMALS);
  const w = round(clamp01(bbox.x1 / prepared.width) - x, LOCATOR_DECIMALS);
  const h = round(clamp01(bbox.y1 / prepared.height) - y, LOCATOR_DECIMALS);
  // A region that rounds away to nothing cannot be a citation target; the
  // text still lands, asset-level, rather than being lost to a validator
  // rejection at the write seam.
  if (w <= 0 || h <= 0 || x + w > 1 || y + h > 1) return undefined;
  return { kind: 'pageRegion', page: 0, x, y, w, h };
}

/** Fragment label: position plus a short excerpt, so a citation list is
 *  readable without loading every fragment's representation. Redacted and
 *  capped again at the write seam. */
function regionLabel(text: string, position: { index: number; total: number }): string {
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, LABEL_EXCERPT_MAX);
  const where = `ocr ${String(position.index + 1)}/${String(position.total)}`;
  return excerpt === '' ? where : `${where}: ${excerpt}`;
}

const CONFIDENCE_DECIMALS = 3;
const LOCATOR_DECIMALS = 6;
const LABEL_EXCERPT_MAX = 80;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
