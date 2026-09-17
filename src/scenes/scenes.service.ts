import { Injectable, NotFoundException } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { BrainScope } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import { sceneUserGate, sceneVisibleToUser } from '../auth/segment-scope';
import { scopeFenceSql } from '../auth/scope-visibility';

/**
 * Scene read surface (SCENES_API_ENABLED, default on → `=0` is a 404):
 * read-only serving of the memory_episode substrate (migration 0106) the
 * composer writes and the belief promotion reads. Until this surface the
 * episodic plane had no reader outside the answer lane: a scene existed
 * only as evidence inside a prompt, and a belief's `sourceSceneIds`
 * pointed at records nothing could open.
 *
 * Fences (the belief read idiom — every miss is a 404, never a 403):
 *  - tenant: withScopedCompany pins the per-tenant database;
 *  - world: only the segmenter world the projection registry holds as
 *    the current one (`live`, else the newest `built`) — an abandoned
 *    world demoted to `residual` stops serving without a migration, and
 *    a tenant with no composed world serves an empty page;
 *  - user scope: via pinUserScope a user-bound token is pinned to its
 *    own user and sees its own scenes plus tenant-global scenes whose
 *    persisted member set is empty or contains it (the 0117 gate the
 *    scene lane applies). An UNSCOPED caller (an M2M key that names no
 *    user) sees tenant-global scenes only — a gist quotes verbatim
 *    member turns, so this is the episode read port's contract, not
 *    the belief API's tenant-wide one; scope to a user with ?userId=.
 *    A row with no well-formed stamp at all is invisible to everyone,
 *    fail-closed;
 *  - PII: `piiClass IS NONE` unless the caller holds brain:read_pii —
 *    a gist quotes member turns (the episode read port's gate);
 *  - scope tags: scopeFenceSql, inert unless SCOPE_TAGS_ENABLED.
 */

export const SCENES_LIST_MAX = 100;
export const SCENES_LIST_DEFAULT = 25;

export interface SceneMemoryValue {
  novelty?: number;
  contradiction?: number;
  stateChange?: number;
  identity?: number;
  explicitness?: number;
  estimatedUtility?: number;
  scorerVersion?: string;
}

export interface SceneStateDelta {
  subject: string;
  field: string;
  from?: string;
  to?: string;
}

/** Wire shape of GET /v1/scenes/:id (and each list member). */
export interface SceneReadResult {
  sceneId: string;
  userId?: string;
  userIds: string[];
  sceneLabel: string;
  gist: string;
  enrichedGist?: string;
  occurredFrom: string;
  occurredTo: string;
  recordedAt: string;
  conversationIds: string[];
  episodeIds: string[];
  entityIds: string[];
  factIds: string[];
  unexpectedDetails: string[];
  stateDeltas: SceneStateDelta[];
  memoryValue?: SceneMemoryValue;
  confidence: number;
  segmenterVersion: string;
  enriched: boolean;
}

/** Wire shape of GET /v1/scenes. */
export interface ScenesListResult {
  scenes: SceneReadResult[];
  found: number;
  world: string;
}

/** Row shape the read queries select (values validated in JS). */
interface SceneReadRow {
  id: unknown;
  userId?: unknown;
  userIds?: unknown;
  sceneLabel?: unknown;
  gist?: unknown;
  enrichedGist?: unknown;
  occurredFrom?: unknown;
  occurredTo?: unknown;
  recordedAt?: unknown;
  conversationIds?: unknown;
  episodeIds?: unknown;
  entityIds?: unknown;
  consolidatedInto?: unknown;
  unexpectedDetails?: unknown;
  stateDeltas?: unknown;
  memoryValue?: unknown;
  enrichedMemoryValue?: unknown;
  confidence?: unknown;
  segmenterVersion?: unknown;
  enrichmentVersion?: unknown;
}

const SELECT_COLUMNS = `id, userId, userIds, sceneLabel, gist, enrichedGist,
              occurredFrom, occurredTo, recordedAt, conversationIds, entityIds,
              consolidatedInto, unexpectedDetails, stateDeltas, memoryValue,
              enrichedMemoryValue, confidence, segmenterVersion, enrichmentVersion,
              (SELECT VALUE out FROM memory_episode_member
                WHERE in = $parent.id ORDER BY ord ASC) AS episodeIds`;

/**
 * The unscoped half of the visibility verdict (the episode read port's
 * `userId IS NONE` contract): a caller who names no user sees only
 * tenant-global scenes, and only those with a persisted member set — an
 * unstamped row is out of contract and hidden from everyone
 * (sceneVisibleToUser's fail-closed leg).
 */
export function sceneVisible(
  row: { userId?: unknown; userIds?: unknown },
  scopeUserId: string | undefined,
): boolean {
  if (scopeUserId !== undefined) return sceneVisibleToUser(row, scopeUserId);
  if (row.userId !== undefined && row.userId !== null) return false;
  return Array.isArray(row.userIds);
}

export interface SceneListOptions {
  companyId: string;
  scopes: readonly BrainScope[];
  userId?: string | undefined;
  conversationId?: string | undefined;
  /** Scene must back-link this entity (`knowledge_entity:<id>` or the tail). */
  entityId?: string | undefined;
  /** ISO instants: scenes overlapping [since, until]. */
  since?: string | undefined;
  until?: string | undefined;
  limit: number;
}

@Injectable()
export class ScenesService {
  constructor(private readonly surreal: SurrealService) {}

  async getScene(opts: {
    companyId: string;
    sceneId: string;
    scopes: readonly BrainScope[];
  }): Promise<SceneReadResult> {
    const scopeUserId = pinUserScope(undefined);
    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
      const rows = await queryRows<SceneReadRow>(
        db,
        `SELECT ${SELECT_COLUMNS}
           FROM type::record('memory_episode', $rid)
          WHERE ${piiFence(opts.scopes) ?? 'true'}
          LIMIT 1`,
        { rid: tailOf(opts.sceneId, 'memory_episode') },
      );
      const scene = rows[0];
      if (!scene || !sceneVisible(scene, scopeUserId)) {
        throw new NotFoundException(`Scene ${opts.sceneId} not found`);
      }
      return toWire(scene);
    });
  }

  async listScenes(opts: SceneListOptions): Promise<ScenesListResult> {
    const scopeUserId = pinUserScope(opts.userId);
    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
      const world = await currentSceneWorld(db);
      if (world === '') return { scenes: [], found: 0, world };
      const clauses = [`segmenterVersion = $world`];
      const params: Record<string, unknown> = { world };
      if (scopeUserId !== undefined) {
        const gate = sceneUserGate(scopeUserId);
        clauses.push(gate.clause.replace(/^AND /u, ''));
        Object.assign(params, gate.params);
      } else {
        // Unscoped: tenant-global rows with a persisted member set — the
        // fail-closed leg of sceneVisible pushed into WHERE, so an
        // out-of-contract row never occupies a page slot.
        clauses.push('userId IS NONE AND userIds IS NOT NONE');
      }
      const scope = scopeFenceSql(scopeUserId);
      if (scope.clause !== '') {
        clauses.push(scope.clause.replace(/^AND /u, ''));
        Object.assign(params, scope.params);
      }
      const pii = piiFence(opts.scopes);
      if (pii !== null) clauses.push(pii);
      if (opts.conversationId !== undefined) {
        clauses.push('conversationIds CONTAINS $conv');
        params.conv = opts.conversationId;
      }
      if (opts.entityId !== undefined) {
        clauses.push(`entityIds CONTAINS type::record('knowledge_entity', $entity)`);
        params.entity = tailOf(opts.entityId, 'knowledge_entity');
      }
      if (opts.since !== undefined) {
        clauses.push('occurredTo >= <datetime>$since');
        params.since = opts.since;
      }
      if (opts.until !== undefined) {
        clauses.push('occurredFrom <= <datetime>$until');
        params.until = opts.until;
      }
      const rows = await queryRows<SceneReadRow>(
        db,
        `SELECT ${SELECT_COLUMNS}
           FROM memory_episode
          WHERE ${clauses.join(' AND ')}
          ORDER BY occurredFrom DESC
          LIMIT ${opts.limit}`,
        params,
      );
      const scenes = rows.filter((r) => sceneVisible(r, scopeUserId)).map(toWire);
      return { scenes, found: scenes.length, world };
    });
  }
}

/** `piiClass IS NONE` unless the caller may read PII (the episode port's gate). */
function piiFence(scopes: readonly BrainScope[]): string | null {
  return scopes.includes('brain:read_pii') ? null : 'piiClass IS NONE';
}

/**
 * The world this tenant currently serves: the version the projection
 * registry marks `live`, else the newest `built` one (the composer
 * promotes to `live` only when the scene lane is on at build time).
 */
export async function currentSceneWorld(db: {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}): Promise<string> {
  // `finishedAt` rides the projection: SurrealDB 3.x orders only by a
  // selected field.
  const [rows] = await db.query<[Array<{ version?: unknown; status?: unknown }>]>(
    `SELECT version, status, finishedAt FROM projection
      WHERE name = 'scenes' AND status IN ['live', 'built']
      ORDER BY finishedAt DESC`,
  );
  const live = (rows ?? []).find((r) => r.status === 'live') ?? (rows ?? [])[0];
  return typeof live?.version === 'string' ? live.version : '';
}

function tailOf(raw: string, table: string): string {
  return raw.startsWith(`${table}:`) ? raw.slice(table.length + 1) : raw;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter((s) => s.length > 0) : [];
/** SDK datetime columns decode to the SDK's DateTime class — duck-type on toISOString. */
const toIso = (v: unknown): string => {
  if (typeof v === 'string') return v;
  const iso = (v as { toISOString?: unknown } | null)?.toISOString;
  return typeof iso === 'function' ? (iso as () => string).call(v) : '';
};

function memoryValueOf(v: unknown): SceneMemoryValue | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out: SceneMemoryValue = {};
  for (const k of [
    'novelty',
    'contradiction',
    'stateChange',
    'identity',
    'explicitness',
    'estimatedUtility',
  ] as const) {
    const n = num(o[k]);
    if (n !== undefined) out[k] = n;
  }
  const scorer = str(o.scorerVersion);
  if (scorer !== undefined) out.scorerVersion = scorer;
  return Object.keys(out).length > 0 ? out : undefined;
}

function deltasOf(v: unknown): SceneStateDelta[] {
  if (!Array.isArray(v)) return [];
  const out: SceneStateDelta[] = [];
  for (const d of v) {
    if (typeof d !== 'object' || d === null) continue;
    const o = d as Record<string, unknown>;
    const subject = str(o.subject);
    const field = str(o.field);
    if (subject === undefined || field === undefined) continue;
    const from = str(o.from);
    const to = str(o.to);
    out.push({
      subject,
      field,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
  }
  return out;
}

/** Wire mapping — record ids stringified, datetimes normalized to ISO. */
function toWire(row: SceneReadRow): SceneReadResult {
  const userId = str(row.userId);
  const enrichedGist = str(row.enrichedGist);
  const enriched = str(row.enrichmentVersion) !== undefined;
  const memoryValue = memoryValueOf(row.enrichedMemoryValue) ?? memoryValueOf(row.memoryValue);
  return {
    sceneId: String(row.id),
    ...(userId !== undefined ? { userId } : {}),
    userIds: strings(row.userIds),
    sceneLabel: String(row.sceneLabel ?? ''),
    gist: String(row.gist ?? ''),
    ...(enrichedGist !== undefined ? { enrichedGist } : {}),
    occurredFrom: toIso(row.occurredFrom),
    occurredTo: toIso(row.occurredTo),
    recordedAt: toIso(row.recordedAt),
    conversationIds: strings(row.conversationIds),
    episodeIds: strings(row.episodeIds),
    entityIds: strings(row.entityIds),
    factIds: strings(row.consolidatedInto),
    unexpectedDetails: strings(row.unexpectedDetails),
    stateDeltas: deltasOf(row.stateDeltas),
    ...(memoryValue !== undefined ? { memoryValue } : {}),
    confidence: num(row.confidence) ?? 0,
    segmenterVersion: String(row.segmenterVersion ?? ''),
    enriched,
  };
}
