/**
 * PROCESS_ROLE — one-env convenience mapping for splitting the single
 * do-everything deployment into an HTTP-only pod and a jobs/crons pod.
 *
 * The split machinery already exists piecewise:
 *   - WORKER_LOOP_ENABLED=0 disables the job_run claim/dispatch loop,
 *   - leader leases arbitrate singleton crons across pods,
 *   - cron enqueues are dedupKey-idempotent (double-fire collapses).
 *
 * PROCESS_ROLE bundles the right flags per role so an operator sets ONE
 * env instead of remembering the combination:
 *
 *   all    (default) — no changes; byte-identical single-process behavior.
 *   api             — WORKER_LOOP_ENABLED=0 (no job claiming) and
 *                     JOB_WORKER_POOL_SIZE=0 (the worker_threads pool is
 *                     consumed only by the job dispatcher in this tree —
 *                     verified: no request-path offload uses JobWorkerPool;
 *                     the admin stats endpoint reads it but tolerates an
 *                     empty pool). Crons still fire but are enqueue-only /
 *                     leader-lease-gated — see docs/operations.md.
 *   worker          — keeps the HTTP server (healthcheck + admin need it;
 *                     the compose recipe publishes no ports) and sets
 *                     CHAT_ROUTE_NLI_ENABLED=false so the ~135MB NLI ONNX
 *                     model never loads on a pod that doesn't chat-route.
 *
 * Precedence: a flag the operator set explicitly ALWAYS wins — the role
 * only fills in unset flags. Applied (and skipped-because-explicit)
 * decisions are returned as log lines for the bootstrap logger.
 *
 * Guard rail: PROCESS_ROLE=api|worker with JOBS_QUEUE_MODE != enqueue is
 * a misconfiguration (inline mode executes jobs inside the API process,
 * defeating the split) — validateEnv() fails boot on that combination.
 *
 * MUST run before NestFactory.create: WORKER_LOOP_ENABLED,
 * JOB_WORKER_POOL_SIZE and CHAT_ROUTE_NLI_ENABLED are all captured from
 * the environment during module init.
 */

export const PROCESS_ROLES = ['api', 'worker', 'all'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/** Trim + lowercase; unset means 'all'. */
export function normalizeProcessRole(value: string | undefined): string {
  return (value ?? 'all').trim().toLowerCase();
}

export function isProcessRole(value: string): value is ProcessRole {
  return (PROCESS_ROLES as readonly string[]).includes(value);
}

interface RoleDefault {
  name: string;
  value: string;
  reason: string;
}

// Values below MUST match how each reader parses its flag:
//   - WorkerLoopService: `(env.WORKER_LOOP_ENABLED ?? '1') !== '0'`
//     → the only disabling value is the literal '0'.
//   - JobWorkerPool: `parseInt(config.get('JOB_WORKER_POOL_SIZE', '2'))`
//     → '0' disables the pool.
//   - IntentClassifierService:
//     `config.get('CHAT_ROUTE_NLI_ENABLED', 'true') !== 'false'`
//     → the only disabling value is the literal 'false' (NOT '0').
const ROLE_DEFAULTS: Record<ProcessRole, RoleDefault[]> = {
  all: [],
  api: [
    {
      name: 'WORKER_LOOP_ENABLED',
      value: '0',
      reason: 'api role does not claim/dispatch queued jobs',
    },
    {
      name: 'JOB_WORKER_POOL_SIZE',
      value: '0',
      reason:
        'worker_threads pool serves cpuBound job handlers only — unused without the worker loop',
    },
  ],
  worker: [
    {
      name: 'CHAT_ROUTE_NLI_ENABLED',
      value: 'false',
      reason: 'worker pod does not chat-route; skips the NLI ONNX model load',
    },
  ],
};

/**
 * Apply the PROCESS_ROLE flag bundle to `env`, mutating ONLY flags the
 * operator left unset. Returns human-readable log lines describing what
 * was applied (and what was skipped because explicit env wins).
 *
 * Unknown roles apply nothing — validateEnv() rejects them at boot, so
 * this function never has to guess.
 */
export function applyProcessRole(env: NodeJS.ProcessEnv): string[] {
  const role = normalizeProcessRole(env.PROCESS_ROLE);
  if (!isProcessRole(role)) return [];
  const lines: string[] = [];
  for (const def of ROLE_DEFAULTS[role]) {
    const explicit = env[def.name];
    if (explicit !== undefined) {
      lines.push(
        `PROCESS_ROLE=${role}: ${def.name} explicitly set to "${explicit}" — role default (${def.value}) not applied`,
      );
      continue;
    }
    env[def.name] = def.value;
    lines.push(
      `PROCESS_ROLE=${role}: applied ${def.name}=${def.value} (${def.reason})`,
    );
  }
  return lines;
}
