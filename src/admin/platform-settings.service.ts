import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { encryptSecret, credentialCipherReady } from '../common/secret-cipher';
import {
  applyStoredSettings,
  decodeStoredRows,
  deployValueOf,
  hasDeployValue,
  rememberDeployValue,
  restoreDeployValue,
  isSettingKey,
  SETTINGS_ENV_ONLY,
  SETTINGS_SELECT,
  SettingRefused,
  type StoredSettingRow,
} from '../common/platform-settings';
import { CONFIG_CATALOG } from './config-catalog.data';

/** What a write carries. An options object because four positional arguments is three too many. */
export interface SettingWrite {
  key: string;
  value: string;
  actor: string;
  note?: string | undefined;
}

export interface SettingRow {
  key: string;
  /** Absent for a secret: a stored secret never leaves the service. */
  value: string | null;
  secret: boolean;
  updatedAt: string;
  updatedBy: string;
  note: string | null;
}

const BOOLEAN_VALUES = new Set(['0', '1', 'true', 'false']);
/** How long a write on one replica may take to reach the others. */
const REFRESH_MS = 30_000;

/**
 * The operator's configuration as a service: the read/write half of
 * `platform_setting` (0161), and the reason the other replicas find out.
 *
 * A write lands in the table AND in this process's `process.env` at once,
 * so the operator who flipped a runtime-mutable flag sees it work on the
 * next request. The other N−1 containers are not told; they re-read the
 * table every 30 seconds and apply the difference. That window is the
 * honest cost of keeping the store in the same place every reader already
 * looks (the environment) instead of threading a config client through
 * four hundred call sites — and it is why the panel still says which keys
 * need a restart: for those, converging the environment is not enough.
 */
@Injectable()
export class PlatformSettingsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private readonly catalogue = new Map(CONFIG_CATALOG.map((c) => [c.key, c]));
  private applied = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly surreal: SurrealService) {}

  onModuleInit(): void {
    // main.ts already applied the store to this process before NestJS
    // existed; this loop is for what OTHER replicas write afterwards.
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The raw overrides, for the catalogue projection. */
  async rows(): Promise<StoredSettingRow[]> {
    return this.readAll();
  }

  /** Whether a live change to this key bites without a restart. */
  runtimeMutable(key: string): boolean {
    return this.catalogue.get(key)?.runtimeMutable === true;
  }

  /** Every override, newest write first. Secrets report presence, not value. */
  async list(): Promise<SettingRow[]> {
    const rows = await this.readAll();
    return rows
      .map((r) => ({
        key: r.key,
        value: r.secret ? null : r.value,
        secret: r.secret,
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy,
        note: r.note,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Set an override. The catalogue decides what may be set and whether
   * the value is a secret — never the caller, so a client cannot store a
   * key in the clear by claiming it is not one.
   */
  async set({ key, value, actor, note }: SettingWrite): Promise<boolean> {
    if (!isSettingKey(key))
      throw new SettingRefused(`'${key}' is not an environment variable name`);
    const spec = this.catalogue.get(key);
    if (!spec) throw new SettingRefused(`${key} is not a catalogued setting`);
    if (SETTINGS_ENV_ONLY.has(key)) {
      throw new SettingRefused(
        `${key} is environment-only: it is read before the store, or it is what unlocks the store`,
      );
    }
    if (spec.isBooleanFlag && !BOOLEAN_VALUES.has(value)) {
      throw new SettingRefused(`${key} is a flag — 0, 1, true or false, got '${value}'`);
    }
    if (value.length > 8192) throw new SettingRefused(`${key}: value is over 8192 characters`);
    const secret = spec.secret === true;
    if (secret && !credentialCipherReady()) {
      throw new SettingRefused(
        `${key} is a secret and SOURCE_CREDENTIAL_ENCRYPTION_KEY is not set — a secret is never stored in the clear`,
      );
    }
    const stored = secret ? encryptSecret(value) : value;
    await this.surreal.withAdminDb(async (db) => {
      // `note` is `option<string>`, and SurrealDB refuses NULL for one —
      // an absent note is the field left alone, not a null written into it.
      const noteClause = note === undefined ? ', note = NONE' : ', note = $note';
      await db.query(
        `UPSERT type::record('platform_setting', $key) SET
           key = $key, value = $stored, secret = $secret,
           updatedBy = $actor, updatedAt = time::now()${noteClause}`,
        note === undefined ? { key, stored, secret, actor } : { key, stored, secret, actor, note },
      );
    });
    rememberDeployValue(key, process.env);
    process.env[key] = value;
    this.applied.set(key, value);
    const restartRequired = spec.runtimeMutable !== true;
    this.logger.log(`${key} set by ${actor}${restartRequired ? ' — takes effect on restart' : ''}`);
    return restartRequired;
  }

  /** Drop an override; the deploy's own value stands again. */
  async clear(key: string, actor: string): Promise<boolean> {
    if (!isSettingKey(key))
      throw new SettingRefused(`'${key}' is not an environment variable name`);
    const existed = await this.surreal.withAdminDb(async (db) => {
      const res = await db.query<[unknown[]]>(
        `DELETE type::record('platform_setting', $key) RETURN BEFORE`,
        { key },
      );
      return Array.isArray(res[0]) && res[0].length > 0;
    });
    if (existed) {
      restoreDeployValue(key, process.env);
      this.applied.delete(key);
      this.logger.log(`${key} cleared by ${actor} — the deploy's value stands`);
    }
    return existed;
  }

  /**
   * What the deploy itself set for a key, once the store has taken it
   * over — `undefined` when the deploy set nothing, `null` when the store
   * never touched it and `process.env` is still the deploy's own.
   */
  deployValue(key: string): string | undefined | null {
    return hasDeployValue(key) ? deployValueOf(key) : null;
  }

  /** Re-read the table and apply what another replica changed. */
  async refresh(): Promise<void> {
    let rows: StoredSettingRow[];
    try {
      rows = await this.readAll();
    } catch (e) {
      this.logger.warn(`settings refresh failed, keeping what is applied: ${(e as Error).message}`);
      return;
    }
    const next = new Map(rows.map((r) => [r.key, r.value]));
    const changed = rows.filter((r) => this.applied.get(r.key) !== r.value);
    for (const key of this.applied.keys()) {
      if (!next.has(key)) {
        restoreDeployValue(key, process.env);
        this.logger.log(`${key} cleared elsewhere — the deploy's value stands`);
      }
    }
    if (changed.length > 0) {
      for (const line of applyStoredSettings(process.env, changed)) {
        this.logger.log(`from another replica: ${line}`);
      }
    }
    this.applied = next;
  }

  private async readAll(): Promise<StoredSettingRow[]> {
    return this.surreal.withAdminDb(async (db) => {
      const res = await db.query<[unknown[]]>(SETTINGS_SELECT);
      return decodeStoredRows(res[0], process.env);
    });
  }
}
