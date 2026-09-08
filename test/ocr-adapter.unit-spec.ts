/**
 * Local OCR processor (Brain v2.1 MM) — asserts against a REAL engine run
 * over REAL pixels. Every fixture is synthesised in-process by sharp
 * (libvips' pangocairo text renderer), so nothing binary is committed and
 * the spec proves the adapter recognises what tesseract actually reads,
 * not what a mock was told to return.
 *
 * The offline contract is a first-class assertion here: the spec pins the
 * resolved model paths to the local filesystem, proves no remote URL is
 * configured anywhere in the engine options, and shows the run leaves no
 * traineddata cache behind in the working directory.
 */
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { OcrAdapter } from '../src/evidence/processing/adapters/ocr.adapter';
import {
  OCR_SUPPORTED_LANGUAGES,
  OCR_TESSDATA_VARIANT,
  assertOcrLanguagesLocal,
  isOcrLanguage,
  ocrLangPath,
  ocrPackageLangDir,
  ocrTrainedDataFile,
} from '../src/evidence/processing/adapters/ocr-assets';
import type {
  ProcessorAdapter,
  ProcessorInput,
} from '../src/evidence/processing/processor-adapter';
import { processorConfigFingerprint } from '../src/evidence/processing/processor-fingerprint';
import { validateLocator } from '../src/evidence/locator';

// Same jest-worker hygiene as the image-metadata spec: libvips otherwise
// spins a thread pool and an operation cache inside every worker it is
// loaded into, and this repo has a history of native-module worker
// crashes under the unit suite. Spec-local; production is untouched.
sharp.concurrency(1);
sharp.cache(false);

const adapter = new OcrAdapter();

/** Recognition is a real WASM pass; give the slower fixtures headroom. */
const OCR_TEST_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'EVIDENCE_OCR_ENABLED',
  'EVIDENCE_OCR_LANGS',
  'EVIDENCE_OCR_MIN_CONFIDENCE',
  'EVIDENCE_MAX_BYTES',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.EVIDENCE_OCR_ENABLED = '1';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

/**
 * Render text to a PNG the way a screenshot looks: dark glyphs on white,
 * generous padding (tesseract's segmenter wants margin), rendered large
 * enough that the recogniser is reading type rather than guessing at
 * aliasing.
 */
async function renderText(text: string, dpi = 300): Promise<Buffer> {
  return sharp({
    text: { text, width: 1400, dpi, rgba: false },
  })
    .negate() // sharp renders white-on-black; OCR wants the usual polarity.
    .extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#ffffff' })
    .png()
    .toBuffer();
}

/** A picture with no writing in it at all: flat mid-grey. */
async function renderBlank(): Promise<Buffer> {
  return sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .png()
    .toBuffer();
}

function inputFor(
  bytes: Buffer | null,
  over: Partial<ProcessorInput['asset']> = {},
): ProcessorInput {
  const asset: ProcessorInput['asset'] = {
    id: 'evidence_asset:o1',
    modality: 'image',
    mediaType: 'image/png',
    availability: bytes === null ? 'external' : 'hot',
    byteLength: bytes?.byteLength ?? 123,
    ...over,
  };
  return {
    asset,
    openStream: bytes === null ? null : () => Promise.resolve(Readable.from([bytes])),
  };
}

/** Collapse whitespace so an assertion is about WORDS, not line breaks. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('OcrAdapter.accepts', () => {
  it('takes raster image types on the image modality when OCR is enabled', () => {
    expect(adapter.accepts('image', 'image/png')).toBe(true);
    expect(adapter.accepts('image', 'image/jpeg')).toBe(true);
    expect(adapter.accepts('image', 'image/tiff')).toBe(true);
    expect(adapter.accepts('image', 'image/webp')).toBe(true);
  });

  it('is case- and parameter-insensitive on the media type', () => {
    expect(adapter.accepts('image', 'IMAGE/PNG')).toBe(true);
    expect(adapter.accepts('image', 'image/jpeg; charset=binary')).toBe(true);
    expect(adapter.accepts('image', '  image/tiff  ')).toBe(true);
  });

  it('declines other modalities, PDFs, and SVG (a vector carries real text)', () => {
    expect(adapter.accepts('document', 'image/png')).toBe(false);
    expect(adapter.accepts('video', 'image/png')).toBe(false);
    expect(adapter.accepts('image', 'application/pdf')).toBe(false);
    expect(adapter.accepts('image', 'image/svg+xml')).toBe(false);
  });

  it('declines EVERYTHING while EVIDENCE_OCR_ENABLED is off — the default', () => {
    delete process.env.EVIDENCE_OCR_ENABLED;
    expect(adapter.accepts('image', 'image/png')).toBe(false);
    process.env.EVIDENCE_OCR_ENABLED = '0';
    expect(adapter.accepts('image', 'image/png')).toBe(false);
  });

  it('reads the flag at call time, so a flip needs no restart', () => {
    process.env.EVIDENCE_OCR_ENABLED = '0';
    expect(adapter.accepts('image', 'image/png')).toBe(false);
    process.env.EVIDENCE_OCR_ENABLED = '1';
    expect(adapter.accepts('image', 'image/png')).toBe(true);
  });
});

describe('OcrAdapter offline contract', () => {
  it('resolves every shipped language to an ABSOLUTE local file', () => {
    for (const lang of OCR_SUPPORTED_LANGUAGES) {
      const dir = ocrPackageLangDir(lang);
      const file = ocrTrainedDataFile(lang);
      expect(isAbsolute(dir)).toBe(true);
      expect(dir.endsWith(OCR_TESSDATA_VARIANT)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  });

  it('configures NO remote URL anywhere in the resolved paths', () => {
    const dirs = [
      ...OCR_SUPPORTED_LANGUAGES.map((lang) => ocrPackageLangDir(lang)),
      ocrLangPath(['eng']),
      ocrLangPath([...OCR_SUPPORTED_LANGUAGES]),
    ];
    for (const dir of dirs) {
      expect(isAbsolute(dir)).toBe(true);
      // No scheme: a URL is the ONLY thing that flips tesseract.js from
      // its fs branch to its fetch branch.
      expect(dir).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
      expect(dir.toLowerCase()).not.toContain('http');
      expect(dir.toLowerCase()).not.toContain('cdn');
    }
  });

  it('single language uses the shipped package directory unchanged', () => {
    expect(ocrLangPath(['eng'])).toBe(ocrPackageLangDir('eng'));
    expect(ocrLangPath(['rus'])).toBe(ocrPackageLangDir('rus'));
  });

  it('stages a multi-language set into ONE local directory, idempotently', () => {
    const dir = ocrLangPath(['eng', 'rus']);
    expect(isAbsolute(dir)).toBe(true);
    for (const lang of ['eng', 'rus'] as const) {
      expect(existsSync(join(dir, `${lang}.traineddata.gz`))).toBe(true);
    }
    // Deterministic name, and a second call is a no-op.
    expect(ocrLangPath(['rus', 'eng'])).toBe(dir);
    expect(ocrLangPath(['eng', 'rus'])).toBe(dir);
  });

  it('refuses a language the image does not ship rather than fetching it', () => {
    expect(isOcrLanguage('fra')).toBe(false);
    expect(() => assertOcrLanguagesLocal(['fra'])).toThrow(/not installed/);
    expect(() => assertOcrLanguagesLocal(['fra'])).toThrow(/never downloads/);
    expect(() => assertOcrLanguagesLocal([])).toThrow(/no OCR language configured/);
  });

  it('accepts the shipped set', () => {
    expect(() => assertOcrLanguagesLocal(['eng'])).not.toThrow();
    expect(() => assertOcrLanguagesLocal(['eng', 'rus'])).not.toThrow();
  });

  it(
    'leaves no traineddata cache in the working directory after a run',
    async () => {
      const before = readdirSync(process.cwd()).filter((f) => f.endsWith('.traineddata'));
      await adapter.process(inputFor(await renderText('CACHE CHECK')));
      const after = readdirSync(process.cwd()).filter((f) => f.endsWith('.traineddata'));
      expect(after).toEqual(before);
    },
    OCR_TEST_TIMEOUT_MS,
  );
});

describe('OcrAdapter.process (real recognition)', () => {
  it(
    'reads known text out of a synthesised image',
    async () => {
      const png = await renderText('INVOICE TOTAL 4200 USD');
      const outputs = await adapter.process(inputFor(png));
      expect(outputs.length).toBeGreaterThan(0);
      const joined = flat(outputs.map((o) => o.content ?? '').join(' '));
      expect(joined).toContain('INVOICE');
      expect(joined).toContain('TOTAL');
      expect(joined).toContain('4200');
      for (const output of outputs) expect(output.kind).toBe('ocr');
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'emits a per-region pageRegion locator the write seam will accept',
    async () => {
      const outputs = await adapter.process(inputFor(await renderText('REGION ONE')));
      const located = outputs.filter((o) => o.locator !== undefined);
      expect(located.length).toBeGreaterThan(0);
      for (const output of located) {
        expect(output.locator).toMatchObject({ kind: 'pageRegion', page: 0 });
        // The real validator, against the real modality — an invalid
        // locator would be rejected at the write seam, not here.
        expect(validateLocator('image', output.locator)).toBeNull();
      }
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'reports confidence on the 0..1 scale the representation column asserts',
    async () => {
      const outputs = await adapter.process(inputFor(await renderText('CONFIDENCE CHECK')));
      for (const output of outputs) {
        expect(typeof output.confidence).toBe('number');
        expect(output.confidence!).toBeGreaterThan(0);
        expect(output.confidence!).toBeLessThanOrEqual(1);
      }
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'stamps the language set it actually used, and labels each region',
    async () => {
      const outputs = await adapter.process(inputFor(await renderText('LANG STAMP')));
      for (const output of outputs) {
        expect(output.lang).toBe('eng');
        expect(output.label).toMatch(/^ocr \d+\/\d+/);
      }
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'is deterministic — identical bytes produce identical text and locators',
    async () => {
      const png = await renderText('DETERMINISM 1234');
      const first = await adapter.process(inputFor(png));
      const second = await adapter.process(inputFor(png));
      expect(second.map((o) => o.content)).toEqual(first.map((o) => o.content));
      expect(second.map((o) => o.locator)).toEqual(first.map((o) => o.locator));
      expect(second.map((o) => o.confidence)).toEqual(first.map((o) => o.confidence));
    },
    OCR_TEST_TIMEOUT_MS,
  );
});

describe('OcrAdapter Russian', () => {
  it(
    'reads Cyrillic when the Russian model is selected',
    async () => {
      const png = await renderText('ОТЧЁТ ГОТОВ');
      process.env.EVIDENCE_OCR_LANGS = 'rus';
      const outputs = await adapter.process(inputFor(png));
      const joined = flat(outputs.map((o) => o.content ?? '').join(' '));
      expect(joined).toMatch(/[А-Яа-яЁё]/);
      expect(joined).toContain('ГОТОВ');
      for (const output of outputs) expect(output.lang).toBe('rus');
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'loads a multi-language set from local models only',
    async () => {
      process.env.EVIDENCE_OCR_LANGS = 'eng+rus';
      const outputs = await adapter.process(inputFor(await renderText('REPORT READY')));
      expect(flat(outputs.map((o) => o.content ?? '').join(' '))).toContain('REPORT');
      for (const output of outputs) expect(output.lang).toBe('eng+rus');
    },
    OCR_TEST_TIMEOUT_MS,
  );
});

describe('OcrAdapter confidence floor', () => {
  it(
    'drops every word and fails the run when the floor is unreachable',
    async () => {
      const png = await renderText('THIS TEXT IS PERFECTLY LEGIBLE');
      // No engine reaches 101 — the whole reading must be discarded.
      process.env.EVIDENCE_OCR_MIN_CONFIDENCE = '100';
      await expect(adapter.process(inputFor(png))).rejects.toThrow(
        /no text recognised above the confidence floor/,
      );
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'keeps the same text when the floor is permissive',
    async () => {
      const png = await renderText('FLOOR SANITY 77');
      process.env.EVIDENCE_OCR_MIN_CONFIDENCE = '0';
      const permissive = await adapter.process(inputFor(png));
      expect(flat(permissive.map((o) => o.content ?? '').join(' '))).toContain('FLOOR');
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'stays silent about drops when nothing was dropped',
    async () => {
      const png = await renderText('CLEAR WORDS HERE');
      process.env.EVIDENCE_OCR_MIN_CONFIDENCE = '0';
      const clean = await adapter.process(inputFor(png));
      expect(clean.every((o) => !(o.content ?? '').includes('[ocr:'))).toBe(true);
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    'states a PARTIAL reading in the stored text rather than swallowing it',
    async () => {
      // The engine is deterministic for fixed bytes, but the exact
      // per-word confidences of a rendered fixture are not a number this
      // spec should hard-code. Raising the floor step by step over the
      // SAME image walks from "everything survives" to "nothing does";
      // somewhere in between the reading is partial, and the contract
      // under test is that a partial reading says so.
      const png = await renderText('ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT');
      process.env.EVIDENCE_OCR_MIN_CONFIDENCE = '0';
      const full = flat(
        (await adapter.process(inputFor(png))).map((o) => o.content ?? '').join(' '),
      );
      expect(full.length).toBeGreaterThan(0);

      let notice: string | null = null;
      for (const floor of [70, 80, 85, 88, 90, 92, 94, 96, 98]) {
        process.env.EVIDENCE_OCR_MIN_CONFIDENCE = String(floor);
        let outputs;
        try {
          outputs = await adapter.process(inputFor(png));
        } catch {
          // Floor above every word: an honest failed run, tested above.
          continue;
        }
        const partial = outputs.find((o) => (o.content ?? '').includes('[ocr:'));
        if (partial) {
          notice = partial.content!;
          break;
        }
      }
      expect(notice).not.toBeNull();
      expect(notice!).toMatch(/\[ocr: \d+ low-confidence words? dropped\]/);
      // The surviving text really is shorter than the unfiltered reading.
      expect(flat(notice!.replace(/\[ocr:[^\]]*\]/, '')).length).toBeLessThan(full.length);
    },
    OCR_TEST_TIMEOUT_MS,
  );
});

describe('OcrAdapter honest emptiness', () => {
  it(
    'fails the run on an image with no writing in it, never emitting noise',
    async () => {
      await expect(adapter.process(inputFor(await renderBlank()))).rejects.toThrow(
        /no legible text|no text recognised/,
      );
    },
    OCR_TEST_TIMEOUT_MS,
  );
});

describe('OcrAdapter failure modes', () => {
  it('fails honestly on an oversize blob instead of buffering it', async () => {
    const png = await renderText('OVERSIZE');
    process.env.EVIDENCE_MAX_BYTES = '16';
    await expect(adapter.process(inputFor(png))).rejects.toThrow(/exceed the evidence size cap/);
  });

  it('fails honestly on corrupt bytes instead of crashing', async () => {
    const junk = Buffer.from('this is definitely not an image, not even a little');
    await expect(adapter.process(inputFor(junk))).rejects.toThrow();
  });

  it('fails honestly on a truncated image header', async () => {
    const png = await renderText('TRUNCATED');
    await expect(adapter.process(inputFor(png.subarray(0, 24)))).rejects.toThrow();
  });

  it('names the reason when the asset carries no readable bytes', async () => {
    await expect(adapter.process(inputFor(null))).rejects.toThrow(/bytes are not readable/);
  });

  it('refuses an unshipped language BEFORE reading a byte', async () => {
    process.env.EVIDENCE_OCR_LANGS = 'fra';
    // openStream would throw if it were reached; it must not be.
    const never: ProcessorInput = {
      asset: inputFor(null).asset,
      openStream: () => Promise.reject(new Error('stream must not be opened')),
    };
    await expect(adapter.process(never)).rejects.toThrow(/not installed/);
  });
});

describe('OcrAdapter deadline enforcement', () => {
  it('races work against a wall-clock bound and names the step that blew it', async () => {
    // The adapter's own deadlines are 10-30 s; asserting them literally
    // would mean a 30 s test. The contract under test is that the shared
    // helper the adapter uses REJECTS rather than hanging, with a message
    // naming the step — the same helper, the same labels.
    const { withDeadline } = await import('../src/evidence/processing/adapters/adapter-io');
    const hang = new Promise<never>(() => {});
    await expect(withDeadline(hang, { ms: 5, label: 'OCR recognition' })).rejects.toThrow(
      /OCR recognition exceeded its 5ms deadline/,
    );
  });

  it('runs its terminator when the deadline fires, so no engine is left behind', async () => {
    const { withDeadline } = await import('../src/evidence/processing/adapters/adapter-io');
    let terminated = false;
    const hang = new Promise<never>(() => {});
    await expect(
      withDeadline(hang, {
        ms: 5,
        label: 'OCR engine start',
        onTimeout: () => {
          terminated = true;
        },
      }),
    ).rejects.toThrow(/OCR engine start/);
    expect(terminated).toBe(true);
  });
});

describe('OcrAdapter fingerprint discipline', () => {
  it('is stable across runs under identical configuration', () => {
    const fp = processorConfigFingerprint(adapter);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(processorConfigFingerprint(new OcrAdapter())).toBe(fp);
  });

  it('pins the language set, model generation, floor, prep and region cap', () => {
    expect(adapter.configParts()).toEqual([
      'langs=eng',
      `tessdata=${OCR_TESSDATA_VARIANT}`,
      'minConfidence=60',
      'prep=grey-2000px-png-v1',
      'maxRegions=64',
    ]);
  });

  it('forks the key when the confidence floor changes', () => {
    const before = processorConfigFingerprint(adapter);
    process.env.EVIDENCE_OCR_MIN_CONFIDENCE = '75';
    expect(processorConfigFingerprint(adapter)).not.toBe(before);
  });

  it('forks the key when the language set changes', () => {
    const before = processorConfigFingerprint(adapter);
    process.env.EVIDENCE_OCR_LANGS = 'eng+rus';
    expect(adapter.configParts()[0]).toBe('langs=eng+rus');
    expect(processorConfigFingerprint(adapter)).not.toBe(before);
  });

  it('treats language ORDER as significant — tesseract does', () => {
    process.env.EVIDENCE_OCR_LANGS = 'eng+rus';
    const engFirst = processorConfigFingerprint(adapter);
    process.env.EVIDENCE_OCR_LANGS = 'rus+eng';
    expect(processorConfigFingerprint(adapter)).not.toBe(engFirst);
  });

  it('forks the key on a version bump', () => {
    const bumped: ProcessorAdapter = {
      capability: adapter.capability,
      version: 'image-ocr-tesseract-v2',
      configParts: () => adapter.configParts(),
      accepts: () => true,
      process: () => Promise.resolve([]),
    };
    expect(processorConfigFingerprint(bumped)).not.toBe(processorConfigFingerprint(adapter));
  });
});
