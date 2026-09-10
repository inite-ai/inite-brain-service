/**
 * Point transformers.js at the container's model cache.
 *
 * transformers.js v2 ignores the python-style TRANSFORMERS_CACHE / HF_HOME
 * variables and defaults to a `.cache` directory inside its own package
 * folder, which is root-owned in our image while the process runs as
 * `node`: every write fails with EACCES and the model re-downloads on the
 * next boot. Every load site must call this before `pipeline(...)`.
 */
export function applyTransformersCacheDir(mod: unknown): void {
  const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
  if (!cacheDir) return;
  (mod as { env?: { cacheDir?: string } }).env ??= {};
  (mod as { env: { cacheDir?: string } }).env.cacheDir = cacheDir;
}
