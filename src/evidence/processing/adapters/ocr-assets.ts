import { accessSync, constants, copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * OCR ASSET RESOLUTION — the module that makes the OCR adapter genuinely
 * offline, and the one place a remote URL could ever have entered.
 *
 * THE PROBLEM. tesseract.js is CDN-first by default. Handed no
 * `langPath`, its worker builds
 * `https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0[_best_int]`
 * and fetches ~3-11 MB of `.traineddata.gz` over the network on first
 * use (src/worker-script/index.js, `langPathDownload`). A memory service
 * that reaches a third-party CDN mid-ingest is unacceptable here: it is
 * an unaudited runtime dependency, an egress hole out of a tenant's data
 * path, and a silent failure mode in an air-gapped deployment.
 *
 * THE SOLUTION, in two halves:
 *
 *   * THE WASM CORE needs no work — and that is a property of the
 *     package, not luck. In Node, tesseract.js's core loader
 *     (src/worker-script/node/getCore.js) `require`s
 *     `tesseract.js-core/tesseract-core-*` straight out of node_modules
 *     and IGNORES the `corePath` option entirely (corePath is a
 *     browser-only knob — the browser loader is the one that fetches).
 *     The core therefore ships in the image as an ordinary transitive
 *     dependency, integrity-pinned by the lockfile like every other one.
 *     The same holds for `workerPath`: node's defaultOptions points it at
 *     the packaged `worker-script/node/index.js` on disk.
 *
 *   * THE LANGUAGE DATA is resolved HERE, to a directory inside
 *     node_modules, and passed as `langPath`. tesseract.js only takes its
 *     fetch branch when `isURL(langPath)` (or the value starts with a
 *     `file://`/extension scheme); an absolute POSIX path is none of
 *     those, so the worker reads the file with `fs.readFile` instead. We
 *     assert the file is really there BEFORE the engine starts, so a
 *     packaging mistake is an honest failed run naming the missing model
 *     — never a fetch, never a hang.
 *
 * WHY AN npm DEPENDENCY rather than committed blobs or a Docker-build
 * download: `@tesseract.js-data/<lang>` is content-hashed in
 * pnpm-lock.yaml, so it is reproducible, auditable and installed by the
 * SAME `pnpm install --frozen-lockfile` the image already runs — no new
 * build-time network step, no multi-megabyte binaries in git history
 * that every clone and every CI job would pay for forever, and unit
 * tests exercise the real models. See the PR for the full trade-off.
 *
 * VARIANT. Each data package ships two tessdata generations: `4.0.0`
 * (the full legacy+LSTM set) and `4.0.0_best_int` (the integerised
 * best-quality LSTM set). We pin `4.0.0_best_int`: the adapter runs
 * LSTM-only, so the legacy tables in the full set are dead weight
 * (~11 MB vs ~3 MB for English) and the integerised best models are the
 * more accurate of the two LSTM options.
 */

/** Languages whose traineddata ships with the image. An operator may
 *  select a SUBSET (EVIDENCE_OCR_LANGS); anything outside this list is
 *  refused rather than fetched. */
export const OCR_SUPPORTED_LANGUAGES = ['eng', 'rus'] as const;
export type OcrLanguage = (typeof OCR_SUPPORTED_LANGUAGES)[number];

/** The tessdata generation pinned above; part of the model identity, so
 *  it rides the adapter's fingerprint. */
export const OCR_TESSDATA_VARIANT = '4.0.0_best_int';

/**
 * Literal specifiers, one per language: `require.resolve` of a computed
 * string would defeat static analysis (and any future bundler), and the
 * set is closed by design — adding a language is a deliberate dependency
 * addition, not a config value.
 */
const DATA_PACKAGE_MANIFESTS: Record<OcrLanguage, string> = {
  eng: '@tesseract.js-data/eng/package.json',
  rus: '@tesseract.js-data/rus/package.json',
};

export function isOcrLanguage(value: string): value is OcrLanguage {
  return (OCR_SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The shipped package directory holding one language's
 * `<lang>.traineddata.gz`. Absolute by construction (require.resolve
 * returns an absolute path), which is exactly what keeps tesseract.js on
 * its filesystem branch.
 */
export function ocrPackageLangDir(lang: OcrLanguage): string {
  return join(dirname(require.resolve(DATA_PACKAGE_MANIFESTS[lang])), OCR_TESSDATA_VARIANT);
}

/** The file the worker will actually read for one language. */
export function ocrTrainedDataFile(lang: OcrLanguage): string {
  return join(ocrPackageLangDir(lang), `${lang}.traineddata.gz`);
}

/**
 * The ONE directory handed to tesseract.js as `langPath`.
 *
 * Single language — overwhelmingly the common case, and the default — is
 * the shipped package directory itself: nothing is created, nothing is
 * written, the engine reads the file npm installed.
 *
 * MULTIPLE languages need staging, because `langPath` is one directory
 * while each `@tesseract.js-data/<lang>` package owns its own. The stage
 * is a directory of SYMLINKS (a copy only where symlinks are
 * unavailable), named deterministically after the model generation and
 * the language set, created lazily and idempotently — concurrent runs
 * race harmlessly on EEXIST, and a second run finds it already built. No
 * bytes are duplicated, nothing is downloaded, and every link points
 * inside node_modules.
 *
 * It lives under the OS temp directory rather than beside the packages
 * because node_modules is legitimately read-only in a hardened image, and
 * beside the app because a container's temp dir is per-instance and
 * disposable — this is derived state that can always be rebuilt from the
 * installed packages.
 */
export function ocrLangPath(langs: readonly OcrLanguage[]): string {
  const first = langs[0];
  if (first === undefined) throw new Error('ocrLangPath needs at least one language');
  if (langs.length === 1) return ocrPackageLangDir(first);
  const dir = join(
    tmpdir(),
    `inite-brain-tessdata-${OCR_TESSDATA_VARIANT}-${[...langs].sort().join('-')}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const lang of langs) {
    const target = join(dir, `${lang}.traineddata.gz`);
    try {
      accessSync(target, constants.R_OK);
      continue;
    } catch {
      // Not staged yet (or staged as a broken link) — (re)create it.
    }
    const source = ocrTrainedDataFile(lang);
    try {
      symlinkSync(source, target);
    } catch {
      // EEXIST from a concurrent run, or a platform without symlinks.
      try {
        accessSync(target, constants.R_OK);
      } catch {
        copyFileSync(source, target);
      }
    }
  }
  return dir;
}

/**
 * Fail BEFORE the engine starts when a requested language is unknown or
 * its model is not on disk. Two guarantees in one check: an unsupported
 * language can never reach tesseract.js (where an unknown `langPath`
 * miss would still be a local ENOENT, but the language list itself is
 * operator input), and a broken image says which model is missing
 * instead of stalling on a network read.
 *
 * Also asserts every resolved path is absolute — the single property
 * that keeps tesseract.js out of its fetch branch.
 */
export function assertOcrLanguagesLocal(langs: readonly string[]): asserts langs is OcrLanguage[] {
  if (langs.length === 0) {
    throw new Error('no OCR language configured (EVIDENCE_OCR_LANGS resolved to an empty set)');
  }
  for (const lang of langs) {
    if (!isOcrLanguage(lang)) {
      throw new Error(
        `OCR language '${lang}' is not installed — this build ships ` +
          `${OCR_SUPPORTED_LANGUAGES.join(', ')} and never downloads models at runtime`,
      );
    }
    const file = ocrTrainedDataFile(lang);
    if (!isAbsolute(file)) {
      throw new Error(`OCR model path for '${lang}' is not absolute — refusing to run`);
    }
    try {
      accessSync(file, constants.R_OK);
    } catch {
      throw new Error(
        `OCR model for '${lang}' is missing from the image (${OCR_TESSDATA_VARIANT}) — ` +
          'reinstall dependencies; models are never fetched at runtime',
      );
    }
  }
}
