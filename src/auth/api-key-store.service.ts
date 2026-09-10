import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyRecord, BrainScope } from './api-key.types';

/** Plaintext shape: `brain_` + 48 lowercase hex (24 random bytes). */
const KEY_PREFIX = 'brain_';
const KEY_BYTES = 24;
/** Enough of the plaintext to recognise a row, far too little to use it. */
const DISPLAY_PREFIX_LEN = KEY_PREFIX.length + 6;

/**
 * How long a resolved (or missing) key stays cached in-process. Every
 * authenticated request hits this path, and the store lives in the system
 * DB — without a cache a busy tenant turns each request into a round
 * trip. 30s is short enough that a revoke issued on another pod takes
 * effect promptly; the pod that performs the revoke drops its own entry
 * immediately.
 */
const CACHE_TTL_MS = 30_000;

/** Per-key throttle on the lastUsedAt write, mirroring tenant_registry.touch(). */
const USED_STAMP_THROTTLE_MS = 5 * 60_000;

/**
 * Active keys one tenant may hold. Not a billing lever — a blast-radius
 * and hygiene bound, so a scripted loop cannot fill the system DB and so
 * a key list stays something a human can read.
 */
export const MAX_ACTIVE_KEYS_PER_TENANT = 25;

/** One key as a listing shows it — everything except the secret. */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  userId?: string;
  createdAt?: string;
  createdBy?: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface IssueKeyInput {
  companyId: string;
  name: string;
  scopes: BrainScope[];
  userId?: string;
  policyNames?: string[];
  expiresAt?: Date;
  createdBy?: string;
}

/** The one and only time the plaintext exists outside the caller's hands. */
export interface IssuedKey {
  key: string;
  summary: ApiKeySummary;
}

interface ApiKeyRow {
  id?: unknown;
  companyId?: string;
  keyHash?: string;
  name?: string;
  prefix?: string;
  scopes?: string[];
  policyNames?: string[];
  userId?: string;
  createdBy?: string;
  createdAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** Surreal record ids arrive as objects or strings depending on the driver path. */
function rowId(raw: unknown): string {
  if (typeof raw === 'string') return raw.includes(':') ? raw.split(':')[1]! : raw;
  const id = (raw as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : String(id ?? '');
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Keys brain issues itself, stored in the system DB (migration 0144).
 *
 * The third credential source, alongside auth-service JWTs and ik_
 * introspection — and the only one that works identically on the hosted
 * service and in a self-hosted deployment, which has no auth-service to
 * ask. Plaintext is generated here, returned once, and never stored: the
 * row holds `sha256:<hex>`, the same convention the BRAIN_API_KEYS env
 * table uses, so both sources compare the same way.
 *
 * Authority is never widened here. The caller decides which scopes to
 * request; the controller narrows them to what the CALLER already holds
 * before this service ever sees them. This class enforces the tenant
 * boundary (every read and write is filtered by companyId) and the
 * lifecycle (expiry, revocation), not the policy.
 */
@Injectable()
export class ApiKeyStoreService {
  private readonly logger = new Logger(ApiKeyStoreService.name);
  private readonly cache = new Map<string, { record: ApiKeyRecord | null; until: number }>();
  private readonly lastStampedAt = new Map<string, number>();

  constructor(@Optional() private readonly surreal?: SurrealService) {}

  /** True when there is a database to store keys in at all. */
  enabled(): boolean {
    return this.surreal !== undefined;
  }

  static hash(plaintext: string): string {
    return 'sha256:' + createHash('sha256').update(plaintext).digest('hex');
  }

  /** Cheap pre-filter: only our own key shape is worth a store lookup. */
  static looksLikeStoredKey(token: string): boolean {
    return token.startsWith(KEY_PREFIX);
  }

  async issue(input: IssueKeyInput): Promise<IssuedKey> {
    if (!this.surreal) throw new Error('key store unavailable: no database connection');
    const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString('hex');
    const keyHash = ApiKeyStoreService.hash(key);
    const id = randomUUID();
    const row: Record<string, unknown> = {
      companyId: input.companyId,
      keyHash,
      name: input.name,
      prefix: key.slice(0, DISPLAY_PREFIX_LEN),
      scopes: input.scopes,
      policyNames: input.policyNames ?? undefined,
      userId: input.userId ?? undefined,
      createdBy: input.createdBy ?? undefined,
      expiresAt: input.expiresAt ?? undefined,
    };
    const stored = await this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[ApiKeyRow[]]>(
        `CREATE type::record('api_key', $id) CONTENT $row RETURN AFTER`,
        { id, row },
      );
      return rows?.[0];
    });
    return { key, summary: this.toSummary(stored ?? { ...row, keyHash }, id) };
  }

  /**
   * Resolve a plaintext key to the record the guard authenticates with,
   * or null when it is unknown, expired or revoked. Never throws: a
   * database blip must read as "this source does not recognise the
   * token", leaving the other credential sources to answer.
   */
  async resolve(plaintext: string): Promise<ApiKeyRecord | null> {
    if (!this.surreal || !ApiKeyStoreService.looksLikeStoredKey(plaintext)) return null;
    const keyHash = ApiKeyStoreService.hash(plaintext);
    const cached = this.cache.get(keyHash);
    const now = Date.now();
    if (cached && cached.until > now) {
      if (cached.record) this.stampUsed(keyHash);
      return cached.record;
    }

    let record: ApiKeyRecord | null = null;
    try {
      const row = await this.surreal.withAdminDb(async (db) => {
        const [rows] = await db.query<[ApiKeyRow[]]>(
          `SELECT * FROM api_key WHERE keyHash = $keyHash LIMIT 1`,
          { keyHash },
        );
        return rows?.[0];
      });
      record = this.toRecord(row);
    } catch (err) {
      // Do not cache an error as an absence — the next request retries.
      this.logger.warn(`key store lookup failed: ${(err as Error).message}`);
      return null;
    }

    this.cache.set(keyHash, { record, until: now + CACHE_TTL_MS });
    if (record) this.stampUsed(keyHash);
    return record;
  }

  async list(companyId: string): Promise<ApiKeySummary[]> {
    if (!this.surreal) return [];
    const rows = await this.surreal.withAdminDb(async (db) => {
      const [result] = await db.query<[ApiKeyRow[]]>(
        `SELECT * FROM api_key WHERE companyId = $companyId ORDER BY createdAt DESC`,
        { companyId },
      );
      return result ?? [];
    });
    return rows.map((row) => this.toSummary(row, rowId(row.id)));
  }

  /**
   * Revoke one key belonging to this tenant. Returns false when the id
   * is unknown *or* belongs to someone else — the two are deliberately
   * indistinguishable to the caller, so a 404 cannot be used to probe
   * for key ids in other tenants.
   */
  async revoke(companyId: string, id: string): Promise<boolean> {
    if (!this.surreal) return false;
    const row = await this.surreal.withAdminDb(async (db) => {
      // Read first: the update must not touch a row from another tenant,
      // and the hash is needed to drop the cache entry.
      const [found] = await db.query<[ApiKeyRow[]]>(`SELECT * FROM type::record('api_key', $id)`, {
        id,
      });
      const candidate = found?.[0];
      if (!candidate || candidate.companyId !== companyId || candidate.revokedAt) return undefined;
      await db.query(`UPDATE type::record('api_key', $id) SET revokedAt = time::now()`, { id });
      return candidate;
    });
    if (!row?.keyHash) return false;
    this.cache.delete(row.keyHash);
    return true;
  }

  /** Active (not revoked, not expired) key count — the issue-time bound. */
  async activeCount(companyId: string): Promise<number> {
    const keys = await this.list(companyId);
    const now = Date.now();
    return keys.filter((k) => !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > now))
      .length;
  }

  private toRecord(row: ApiKeyRow | undefined): ApiKeyRecord | null {
    if (!row?.keyHash || !row.companyId) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && Date.parse(String(row.expiresAt)) <= Date.now()) return null;
    const record: ApiKeyRecord = {
      keyHash: row.keyHash,
      companyId: row.companyId,
      scopes: (row.scopes ?? []) as BrainScope[],
    };
    if (row.name) record.name = row.name;
    if (row.userId) record.userId = row.userId;
    if (row.policyNames?.length) record.policyNames = row.policyNames;
    return record;
  }

  private toSummary(row: ApiKeyRow, id: string): ApiKeySummary {
    const summary: ApiKeySummary = {
      id,
      name: row.name ?? '',
      prefix: row.prefix ?? '',
      scopes: row.scopes ?? [],
    };
    // exactOptionalPropertyTypes: an absent field must stay absent, not
    // become `undefined`, so each one is assigned only when present.
    const userId = isoOrUndefined(row.userId);
    if (userId !== undefined) summary.userId = userId;
    const createdAt = isoOrUndefined(row.createdAt);
    if (createdAt !== undefined) summary.createdAt = createdAt;
    const createdBy = isoOrUndefined(row.createdBy);
    if (createdBy !== undefined) summary.createdBy = createdBy;
    const expiresAt = isoOrUndefined(row.expiresAt);
    if (expiresAt !== undefined) summary.expiresAt = expiresAt;
    const revokedAt = isoOrUndefined(row.revokedAt);
    if (revokedAt !== undefined) summary.revokedAt = revokedAt;
    const lastUsedAt = isoOrUndefined(row.lastUsedAt);
    if (lastUsedAt !== undefined) summary.lastUsedAt = lastUsedAt;
    return summary;
  }

  /**
   * Record that a key was used, at most once per key per window, without
   * making the caller wait for it or fail on it.
   */
  private stampUsed(keyHash: string): void {
    const now = Date.now();
    const last = this.lastStampedAt.get(keyHash) ?? 0;
    if (now - last < USED_STAMP_THROTTLE_MS) return;
    this.lastStampedAt.set(keyHash, now);
    void this.surreal
      ?.withAdminDb(async (db) => {
        await db.query(`UPDATE api_key SET lastUsedAt = time::now() WHERE keyHash = $keyHash`, {
          keyHash,
        });
      })
      .catch((err) => this.logger.debug(`lastUsedAt stamp failed: ${(err as Error).message}`));
  }
}
