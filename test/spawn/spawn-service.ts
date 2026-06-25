import { ProcessManager } from './process-manager';
import { newBrainKey, newCompanyId, BrainKeySpec } from './key-factory';
import { loadOpenAiKey } from './openai-key-loader';
import { waitForHealth } from './health-waiter';

export interface SpawnedService {
  baseUrl: string;
  /** Primary key — full scopes by default. */
  primary: BrainKeySpec;
  /**
   * Optional additional keys requested by the test (e.g. a limited-scope
   * key on the same companyId for PII gating).
   */
  extras: BrainKeySpec[];
  companyId: string;
  stop: () => Promise<void>;
}

export interface SpawnOptions {
  port?: number;
  /** Scopes the primary key carries. Default: all scopes. */
  scopes?: string[];
  /** Additional keys with their own scopes — issued for the same tenant. */
  extraKeyScopes?: string[][];
  /**
   * Extra env vars merged on top of the defaults — opt-in flags
   * for retrieval features (SEARCH_RERANKER_ENABLED, SEARCH_HYPE_ENABLED,
   * DREAMS_*_ENABLED, etc.) so individual specs can exercise paths
   * that are off by default in the standard quality eval.
   */
  env?: Record<string, string>;
}

const DEFAULT_SCOPES = [
  'brain:read',
  'brain:write',
  'brain:admin',
  'brain:read_pii',
];

export async function spawnService(opts: SpawnOptions = {}): Promise<SpawnedService> {
  const port = opts.port ?? 40_000 + Math.floor(Math.random() * 20_000);
  const companyId = newCompanyId();

  const primary = newBrainKey(companyId, opts.scopes ?? DEFAULT_SCOPES);
  const extras = (opts.extraKeyScopes ?? []).map((scopes) =>
    newBrainKey(companyId, scopes),
  );

  const allKeys = [primary, ...extras].map((k) => ({
    keyHash: k.keyHash,
    companyId: k.companyId,
    scopes: k.scopes,
  }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SURREALDB_URL: process.env.SURREALDB_URL,
    SURREALDB_USERNAME: process.env.SURREALDB_USERNAME ?? 'root',
    SURREALDB_PASSWORD: process.env.SURREALDB_PASSWORD ?? 'root',
    SURREALDB_NAMESPACE: 'brain',
    OPENAI_API_KEY: loadOpenAiKey(),
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
    OPENAI_EMBEDDING_DIMENSIONS: '1536',
    // Pinned snapshot — alias `gpt-4o-mini` silently re-targets when
    // OpenAI rolls a new default, which moves eval baselines and breaks
    // delta-gate diffs. Extractor still uses temperature=0.1 (intentional
    // noise for entity recall); everything else is temperature=0.
    OPENAI_CHAT_MODEL: 'gpt-4o-mini-2024-07-18',
    // Disable throttling for the spawned test process. Quality-eval
    // bursts hundreds of ingest+search calls in seconds; the
    // production default (120/min) shields a real tenant but kills
    // the eval harness, producing a self-inflicted false negative.
    // Specs that explicitly want to test throttler behaviour can
    // override via SpawnOptions.env.
    THROTTLE_LIMIT: '100000',
    THROTTLE_TTL_MS: '60000',
    // search / synthesize / ingest sit in the *expensive* throttle tier,
    // which has its own knobs — raising only the default limit above still
    // let quality-eval's burst trip a 429 on /v1/search. Lift the expensive
    // tier too so the harness isn't self-throttled.
    THROTTLE_EXPENSIVE_LIMIT: '100000',
    THROTTLE_EXPENSIVE_TTL_MS: '60000',
    BRAIN_API_KEYS: JSON.stringify(allKeys),
    FORGET_HMAC_KEY: 'test-hmac-key-must-be-at-least-32-chars',
    // Spec-supplied overrides land last so a spec can override anything
    // (including the model — useful for opus-only correctness checks).
    ...(opts.env ?? {}),
  };

  const manager = new ProcessManager();
  manager.start(env);

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (err) {
    await manager.stop();
    throw new Error(
      `Service failed to start.\nstderr:\n${manager
        .capturedStderr()
        .slice(-2000)}\n\nRoot cause: ${(err as Error).message}`,
    );
  }

  return {
    baseUrl,
    primary,
    extras,
    companyId,
    stop: () => manager.stop(),
  };
}
