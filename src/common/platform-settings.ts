import { Surreal } from 'surrealdb';
import { decryptSecret, isEncrypted } from './secret-cipher';

/**
 * The operator's configuration, applied over `process.env` before NestJS
 * boots.
 *
 * Every knob this service has is an environment variable, and until now
 * the only way to change one was to edit `deploy-brain.yml` and ship a
 * release. That is fine for a decision the repository should record and
 * wrong for everything an operator alone can know — the OAuth app
 * registered at Google, a limit raised for an afternoon, a model pinned
 * for one deployment. `platform_setting` (migration 0161) holds those,
 * and this module is how they reach the process.
 *
 * The apply is deliberately crude and that is the point: writing the
 * value into `process.env` means EVERY existing reader sees it — the
 * call-time `process.env.X` of the source-plane flags, the
 * `config.get('X')` a service captured in its constructor, the env
 * validator itself — without one call site learning that a settings
 * store exists. It runs next to `applyProcessRole` in main.ts for the
 * same reason that one does.
 *
 * The environment stays the floor. A key with no row reads exactly what
 * the deploy set, and a store that cannot be read (first boot before the
 * migration, a database still starting) fails OPEN to the deploy's own
 * values rather than booting a service with half a configuration.
 */

/**
 * Keys that may never live in the store, however the catalogue describes
 * them. Two families: what is needed to READ the store (the database
 * connection, and the key its secrets are encrypted under — a key that
 * unlocks the store cannot live inside it), and what decides what this
 * process IS before any of it runs.
 */
export const SETTINGS_ENV_ONLY: ReadonlySet<string> = new Set([
  'SURREALDB_URL',
  'SURREALDB_USERNAME',
  'SURREALDB_PASSWORD',
  'SURREALDB_NAMESPACE',
  'SURREALDB_SCOPED_USER',
  'SURREALDB_SCOPED_PASS',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS',
  'PROCESS_ROLE',
  'NODE_ENV',
  'PORT',
]);

/**
 * What the deploy's environment said, for every key the store has taken
 * over. Captured at the moment of the overwrite, because afterwards
 * `process.env` no longer knows: the panel shows both values, and
 * clearing an override has to put the deploy's own back.
 */
const deployEnv = new Map<string, string | undefined>();

/** Remember what `key` held before the store touches it (first time wins). */
export function rememberDeployValue(key: string, env: NodeJS.ProcessEnv): void {
  if (!isSettingKey(key)) return;
  if (!deployEnv.has(key)) deployEnv.set(key, env[key]);
}

/** The deploy's own value for `key`, or `undefined` when it set none. */
export function deployValueOf(key: string): string | undefined {
  return deployEnv.get(key);
}

/** Whether the store has ever taken this key over in this process. */
export function hasDeployValue(key: string): boolean {
  return deployEnv.has(key);
}

/** Put the deploy's own value back, for a cleared override. */
export function restoreDeployValue(key: string, env: NodeJS.ProcessEnv): void {
  if (!isSettingKey(key)) return;
  const was = deployEnv.get(key);
  if (was === undefined) delete env[key];
  else env[key] = was;
}

/** A write the store refused, with the reason the operator should read. */
export class SettingRefused extends Error {}

/**
 * The shape of an environment variable's name, and the only thing this
 * module will ever write a property for. A row is data — it can be written
 * straight into the table by anything holding the database — so the name
 * is checked rather than trusted: `__proto__` and friends are not
 * environment variables, and `process.env` is still an object.
 */
const SETTING_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Whether `key` is a name this module may write. */
export function isSettingKey(key: string): boolean {
  return SETTING_KEY.test(key);
}

/** One stored override, as the table holds it. */
export interface StoredSetting {
  key: string;
  value: string;
  secret: boolean;
}

/** A stored override with the bookkeeping the panel shows. */
export interface StoredSettingRow extends StoredSetting {
  updatedAt: string;
  updatedBy: string;
  note: string | null;
}

/**
 * Write the store over `env`, skipping what may never come from it.
 * Returns one log line per applied key — values are never logged, and a
 * secret's presence is reported as `(secret)`.
 */
export function applyStoredSettings(
  env: NodeJS.ProcessEnv,
  rows: readonly StoredSetting[],
): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (!isSettingKey(row.key)) {
      lines.push(`refused a stored row: '${row.key}' is not an environment variable name`);
      continue;
    }
    if (SETTINGS_ENV_ONLY.has(row.key)) {
      lines.push(`${row.key}: refused — this key is environment-only`);
      continue;
    }
    const had = env[row.key] !== undefined;
    rememberDeployValue(row.key, env);
    env[row.key] = row.value;
    lines.push(
      `${row.key} = ${row.secret ? '(secret)' : row.value}${had ? ' (overrides the deploy)' : ''}`,
    );
  }
  return lines;
}

/**
 * Read the store straight from SurrealDB, without NestJS: this runs
 * before the application exists. Root credentials and the `system`
 * database, the way every namespace-level table is reached.
 *
 * Any failure — no migration yet, a database still starting, a bad
 * credential — returns nothing and lets the deploy's environment stand.
 */
export async function loadStoredSettings(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000,
): Promise<{ rows: StoredSettingRow[]; warning: string | null }> {
  const url = env.SURREALDB_URL;
  const username = env.SURREALDB_USERNAME;
  const password = env.SURREALDB_PASSWORD;
  const namespace = env.SURREALDB_NAMESPACE;
  if (!url || !username || !password || !namespace) {
    return { rows: [], warning: null };
  }
  const db = new Surreal();
  try {
    await withDeadline(
      (async () => {
        await db.connect(url);
        await db.signin({ username, password });
        await db.use({ namespace, database: 'system' });
      })(),
      timeoutMs,
    );
    const result = await withDeadline(db.query<[unknown[]]>(SETTINGS_SELECT), timeoutMs);
    return { rows: decodeStoredRows(result[0], env), warning: null };
  } catch (e) {
    return { rows: [], warning: (e as Error).message };
  } finally {
    await db.close().catch(() => undefined);
  }
}

/** The one SELECT over the table — the boot loader and the service share it. */
export const SETTINGS_SELECT =
  'SELECT key, value, secret, updatedAt, updatedBy, note FROM platform_setting';

/** Rows as the driver hands them back, with every secret opened. */
export function decodeStoredRows(raw: unknown, env: NodeJS.ProcessEnv): StoredSettingRow[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredSettingRow[] = [];
  for (const row of raw) {
    const r = row as Record<string, unknown>;
    if (typeof r.key !== 'string' || typeof r.value !== 'string') continue;
    if (!isSettingKey(r.key)) continue;
    const secret = r.secret === true;
    // A secret written while the cipher had no key is stored as it
    // arrived; `isEncrypted` tells the two apart so a rotation or a
    // late-configured key never turns a value into gibberish.
    let value = r.value;
    if (isEncrypted(value)) {
      try {
        value = decryptSecret(value, env);
      } catch {
        continue;
      }
    }
    out.push({
      key: r.key,
      value,
      secret,
      updatedAt: stampOf(r.updatedAt),
      updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : 'unknown',
      note: typeof r.note === 'string' ? r.note : null,
    });
  }
  return out;
}

/** SurrealDB hands datetimes back as Date; the wire wants ISO. */
function stampOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : new Date(0).toISOString();
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`platform settings: timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}
