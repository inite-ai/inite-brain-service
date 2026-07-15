/**
 * PROCESS_ROLE — role → flag-bundle mapping (common/process-role.ts) and
 * its boot-time validation (common/env-validation.ts).
 *
 * The mapping is applied in main.ts BEFORE NestFactory.create, mutating
 * process.env only for flags the operator left unset. These tests run the
 * pure function against plain objects — no Nest app, no DB.
 *
 * Load-bearing literals (each matches how the reader parses the flag):
 *   - WORKER_LOOP_ENABLED: WorkerLoopService disables ONLY on '0'.
 *   - JOB_WORKER_POOL_SIZE: JobWorkerPool disables on parseInt(...) === 0.
 *   - CHAT_ROUTE_NLI_ENABLED: IntentClassifierService disables ONLY on the
 *     literal 'false' (NOT '0') — the mapping must emit exactly that.
 */
import { applyProcessRole } from '../src/common/process-role';
import { validateEnv } from '../src/common/env-validation';

function baseDevEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    SURREALDB_URL: 'ws://db:8000',
    SURREALDB_USERNAME: 'root',
    SURREALDB_PASSWORD: 'root',
    OPENAI_API_KEY: 'sk-test',
    BRAIN_API_KEYS: '[]',
  };
}

describe('applyProcessRole — role → flag mapping', () => {
  it('all (explicit) applies nothing and touches no flags', () => {
    const env: NodeJS.ProcessEnv = { PROCESS_ROLE: 'all' };
    const lines = applyProcessRole(env);
    expect(lines).toEqual([]);
    expect(env).toEqual({ PROCESS_ROLE: 'all' });
  });

  it('unset PROCESS_ROLE behaves as all — byte-identical env', () => {
    const env: NodeJS.ProcessEnv = { WORKER_LOOP_ENABLED: '1' };
    const before = { ...env };
    expect(applyProcessRole(env)).toEqual([]);
    expect(env).toEqual(before);
  });

  it('api disables the worker loop and the job worker pool', () => {
    const env: NodeJS.ProcessEnv = { PROCESS_ROLE: 'api' };
    const lines = applyProcessRole(env);
    expect(env.WORKER_LOOP_ENABLED).toBe('0');
    expect(env.JOB_WORKER_POOL_SIZE).toBe('0');
    // Does NOT touch the chat-route flag — that is a worker-role default.
    expect(env.CHAT_ROUTE_NLI_ENABLED).toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('WORKER_LOOP_ENABLED=0');
    expect(lines.join('\n')).toContain('JOB_WORKER_POOL_SIZE=0');
  });

  it('worker disables chat-route NLI with the literal "false"', () => {
    const env: NodeJS.ProcessEnv = { PROCESS_ROLE: 'worker' };
    const lines = applyProcessRole(env);
    // IntentClassifierService parses `... !== 'false'` — '0' would NOT
    // disable it. The exact literal matters.
    expect(env.CHAT_ROUTE_NLI_ENABLED).toBe('false');
    // Worker keeps the queue loop + pool on their normal defaults.
    expect(env.WORKER_LOOP_ENABLED).toBeUndefined();
    expect(env.JOB_WORKER_POOL_SIZE).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('CHAT_ROUTE_NLI_ENABLED=false');
  });

  it('explicit env always wins over the role default', () => {
    const env: NodeJS.ProcessEnv = {
      PROCESS_ROLE: 'api',
      WORKER_LOOP_ENABLED: '1',
      JOB_WORKER_POOL_SIZE: '4',
    };
    const lines = applyProcessRole(env);
    expect(env.WORKER_LOOP_ENABLED).toBe('1');
    expect(env.JOB_WORKER_POOL_SIZE).toBe('4');
    // Skips are still reported so the operator sees the decision.
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain('not applied');
  });

  it('explicit CHAT_ROUTE_NLI_ENABLED wins in worker role', () => {
    const env: NodeJS.ProcessEnv = {
      PROCESS_ROLE: 'worker',
      CHAT_ROUTE_NLI_ENABLED: 'true',
    };
    applyProcessRole(env);
    expect(env.CHAT_ROUTE_NLI_ENABLED).toBe('true');
  });

  it('normalizes case and surrounding whitespace', () => {
    const env: NodeJS.ProcessEnv = { PROCESS_ROLE: '  API ' };
    applyProcessRole(env);
    expect(env.WORKER_LOOP_ENABLED).toBe('0');
    expect(env.JOB_WORKER_POOL_SIZE).toBe('0');
  });

  it('unknown role applies nothing (validation rejects it at boot)', () => {
    const env: NodeJS.ProcessEnv = { PROCESS_ROLE: 'apy' };
    expect(applyProcessRole(env)).toEqual([]);
    expect(env).toEqual({ PROCESS_ROLE: 'apy' });
  });
});

describe('validateEnv — PROCESS_ROLE', () => {
  it('accepts api/worker/all', () => {
    for (const role of ['api', 'worker', 'all']) {
      const env = baseDevEnv();
      env.PROCESS_ROLE = role;
      expect(() => validateEnv(env)).not.toThrow();
    }
  });

  it('accepts unset PROCESS_ROLE', () => {
    expect(() => validateEnv(baseDevEnv())).not.toThrow();
  });

  it('rejects an unknown role', () => {
    const env = baseDevEnv();
    env.PROCESS_ROLE = 'apy';
    expect(() => validateEnv(env)).toThrow(/PROCESS_ROLE must be one of/);
  });

  it('rejects api role with JOBS_QUEUE_MODE=inline', () => {
    const env = baseDevEnv();
    env.PROCESS_ROLE = 'api';
    env.JOBS_QUEUE_MODE = 'inline';
    expect(() => validateEnv(env)).toThrow(/JOBS_QUEUE_MODE=enqueue/);
  });

  it('rejects worker role with JOBS_QUEUE_MODE=inline', () => {
    const env = baseDevEnv();
    env.PROCESS_ROLE = 'worker';
    env.JOBS_QUEUE_MODE = 'inline';
    expect(() => validateEnv(env)).toThrow(/inline mode executes/);
  });

  it('rejects api role with a typo queue mode (parses as inline)', () => {
    const env = baseDevEnv();
    env.PROCESS_ROLE = 'api';
    env.JOBS_QUEUE_MODE = 'enqueu';
    expect(() => validateEnv(env)).toThrow(/JOBS_QUEUE_MODE=enqueue/);
  });

  it('allows role=all with JOBS_QUEUE_MODE=inline (single-process kill switch)', () => {
    const env = baseDevEnv();
    env.PROCESS_ROLE = 'all';
    env.JOBS_QUEUE_MODE = 'inline';
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('allows api role with explicit JOBS_QUEUE_MODE=enqueue', () => {
    const env = baseDevEnv();
    env.PROCESS_ROLE = 'api';
    env.JOBS_QUEUE_MODE = 'enqueue';
    expect(() => validateEnv(env)).not.toThrow();
  });
});
