/**
 * GracefulShutdownService — the one owner of the process shutdown
 * sequence: readiness flips to 503 first, a signal-driven shutdown keeps
 * serving for the readiness drain, the hard-stop deadline forces exit if
 * the lifecycle hangs, and the whole budget fits compose's grace period.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GracefulShutdownService } from '../src/common/graceful-shutdown.service';

const ROOT = join(__dirname, '..');

function constant(file: string, name: string): number {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(src);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return Number(m[1]!.replace(/_/g, ''));
}

describe('GracefulShutdownService', () => {
  let exit: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    exit.mockRestore();
    jest.useRealTimers();
  });

  function mk() {
    const health = { markShuttingDown: jest.fn(), isShuttingDown: () => true };
    return { svc: new GracefulShutdownService(health as never), health };
  }

  it('flips readiness in the first lifecycle phase, before anything else closes', () => {
    const { svc, health } = mk();
    svc.onModuleDestroy();
    expect(health.markShuttingDown).toHaveBeenCalledTimes(1);
  });

  it('holds a signal-driven shutdown for the readiness drain; a programmatic close does not wait', async () => {
    const { svc } = mk();
    let resolved = false;
    const held = svc.beforeApplicationShutdown('SIGTERM').then(() => {
      resolved = true;
    });
    await jest.advanceTimersByTimeAsync(5_999);
    expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await held;
    expect(resolved).toBe(true);

    let quick = false;
    await svc.beforeApplicationShutdown().then(() => {
      quick = true;
    });
    expect(quick).toBe(true);
  });

  it('forces exit 25 s after a signal-driven shutdown began if the lifecycle is still running', async () => {
    const { svc } = mk();
    svc.onModuleDestroy();
    await svc.onApplicationShutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(24_999);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a programmatic close disarms the deadline once the lifecycle has run', async () => {
    const { svc } = mk();
    svc.onModuleDestroy();
    await svc.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('the budget nests: readiness drain + dispatch drain < hard stop < compose stop_grace_period', () => {
    const readiness = constant('src/common/graceful-shutdown.service.ts', 'READINESS_DRAIN_MS');
    const hardStop = constant('src/common/graceful-shutdown.service.ts', 'HARD_STOP_MS');
    const dispatch = constant('src/jobs/worker-loop.service.ts', 'DISPATCH_DRAIN_MS');
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    const graces = [...compose.matchAll(/stop_grace_period:\s*(\d+)s/g)].map((m) => Number(m[1]));
    expect(graces.length).toBeGreaterThan(0);
    expect(readiness + dispatch).toBeLessThan(hardStop);
    for (const grace of graces) expect(hardStop).toBeLessThan(grace * 1000);
  });

  it('signal handling belongs to Nest alone, and the service sits on the root module', () => {
    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    const tracing = readFileSync(join(ROOT, 'src/common/tracing.ts'), 'utf8');
    const appModule = readFileSync(join(ROOT, 'src/app.module.ts'), 'utf8');
    // A second SIGTERM listener ran app.close() concurrently with Nest's
    // own; a lingering one would swallow the exit Nest re-raises.
    expect(main).not.toMatch(/process\.(on|once)\(\s*'SIG/);
    expect(tracing).not.toMatch(/process\.(on|once)\(\s*'SIG/);
    expect(main).toContain('app.enableShutdownHooks()');
    expect(appModule).toMatch(/providers:\s*\[[\s\S]*GracefulShutdownService[\s\S]*\]/);
  });
});
