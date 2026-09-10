import { applyTransformersCacheDir } from '../src/ai/transformers-cache';

/**
 * transformers.js v2 writes downloaded weights to a `.cache` directory
 * inside its own package folder unless `env.cacheDir` is set. That folder is
 * root-owned in the image while the process runs as `node`, so every write
 * fails with EACCES and the model re-downloads on the next boot. Every load
 * site must route through this helper.
 */
describe('applyTransformersCacheDir', () => {
  const saved = {
    cache: process.env.TRANSFORMERS_CACHE,
    home: process.env.HF_HOME,
  };

  afterEach(() => {
    if (saved.cache === undefined) delete process.env.TRANSFORMERS_CACHE;
    else process.env.TRANSFORMERS_CACHE = saved.cache;
    if (saved.home === undefined) delete process.env.HF_HOME;
    else process.env.HF_HOME = saved.home;
  });

  it('honours TRANSFORMERS_CACHE', () => {
    process.env.TRANSFORMERS_CACHE = '/app/.cache';
    delete process.env.HF_HOME;
    const mod = { env: {} as { cacheDir?: string } };
    applyTransformersCacheDir(mod);
    expect(mod.env.cacheDir).toBe('/app/.cache');
  });

  it('falls back to HF_HOME', () => {
    delete process.env.TRANSFORMERS_CACHE;
    process.env.HF_HOME = '/models';
    const mod = { env: {} as { cacheDir?: string } };
    applyTransformersCacheDir(mod);
    expect(mod.env.cacheDir).toBe('/models');
  });

  it('prefers TRANSFORMERS_CACHE over HF_HOME', () => {
    process.env.TRANSFORMERS_CACHE = '/first';
    process.env.HF_HOME = '/second';
    const mod = { env: {} as { cacheDir?: string } };
    applyTransformersCacheDir(mod);
    expect(mod.env.cacheDir).toBe('/first');
  });

  it('leaves the module alone when neither is set', () => {
    delete process.env.TRANSFORMERS_CACHE;
    delete process.env.HF_HOME;
    const mod = { env: {} as { cacheDir?: string } };
    applyTransformersCacheDir(mod);
    expect(mod.env.cacheDir).toBeUndefined();
  });

  it('creates the env slot when the module has none yet', () => {
    process.env.TRANSFORMERS_CACHE = '/app/.cache';
    const mod = {} as { env?: { cacheDir?: string } };
    applyTransformersCacheDir(mod);
    expect(mod.env?.cacheDir).toBe('/app/.cache');
  });
});

describe('every transformers load site routes through the helper', () => {
  /**
   * The in-thread fallbacks were the ones that silently re-downloaded: the
   * worker copies set the directory, their in-process twins did not. This
   * gate fails when a new load site is added without the helper.
   */
  it('has no bare pipeline/from_pretrained call without the helper', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('grep', ['-rl', '@xenova/transformers', 'src', '--include=*.ts'], {
      encoding: 'utf8',
    });
    const loaders = out
      .split('\n')
      .filter((f) => f.length > 0)
      .filter((f) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        const src = fs.readFileSync(f, 'utf8');
        return /await import\('@xenova\/transformers'\)/.test(src);
      });
    expect(loaders.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const missing = loaders.filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return !src.includes('applyTransformersCacheDir') && !src.includes('env.cacheDir');
    });
    expect(missing).toEqual([]);
  });
});
