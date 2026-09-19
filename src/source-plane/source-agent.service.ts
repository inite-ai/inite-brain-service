import { BadRequestException, Injectable } from '@nestjs/common';
import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { sourceFsRoots } from '../common/source-plane-flags';
import type {
  AgentInventory,
  BrowseResponse,
  SourceAgent,
} from '../contracts/source-plane/source-plane.schema';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';

/** Directory entries listed per level before the picker is told "truncated". */
const BROWSE_MAX = 500;
/** Never offered by the picker, whatever is on disk. */
const BROWSE_SKIP = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.cache',
  '.next',
  'dist',
  'build',
  'target',
]);

/**
 * SourceAgentService — presence and inventory of the local agents a
 * tenant has heard from (`source_agent`, 0151), and the brain host's own
 * disk one level at a time inside the SOURCE_FS_ROOTS jail. Both feed
 * the admin's folder picker: the brain cannot see a laptop, so the agent
 * reports what it can see on every pass; the brain can see its own
 * volumes, but only the ones the operator jailed it to.
 */
@Injectable()
export class SourceAgentService {
  constructor(private readonly surreal: SurrealService) {}

  /** An agent's pass: upsert its row (SELECT id → UPDATE $id, the 3.x way). */
  async checkIn(companyId: string, agentId: string, inv: AgentInventory): Promise<void> {
    await this.surreal.withCompany(companyId, async (db) => {
      const existing = await queryFirst<{ id: unknown }>(
        db,
        `SELECT id FROM source_agent WHERE agentId = $agentId LIMIT 1`,
        { agentId },
      );
      // 3.x: option<string> takes NONE, never a JS null — an absent value
      // is an absent key on CREATE and an explicit NONE on UPDATE.
      const fields = {
        lastSeenAt: new Date(),
        ...(inv.version ? { version: inv.version } : {}),
        ...(inv.hostname ? { hostname: inv.hostname } : {}),
        ...(inv.platform ? { platform: inv.platform } : {}),
        inventory: { roots: inv.roots, databases: inv.databases ?? [] },
      };
      if (existing) {
        const set = (k: 'version' | 'hostname' | 'platform') => (k in fields ? `$${k}` : 'NONE');
        await db.query(
          `UPDATE $id SET lastSeenAt = $lastSeenAt, version = ${set('version')}, hostname = ${set('hostname')}, platform = ${set('platform')}, inventory = $inventory`,
          { id: existing.id, ...fields },
        );
      } else {
        await db.query(`CREATE source_agent CONTENT $content`, {
          content: { agentId, ...fields },
        });
      }
    });
  }

  async list(companyId: string): Promise<SourceAgent[]> {
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<RawAgent>(db, `SELECT * FROM source_agent ORDER BY lastSeenAt DESC LIMIT 200`),
    );
    return rows.map(toAgent);
  }

  /**
   * One level of the brain host's disk. `path` empty ⇒ the jail roots
   * themselves; anything outside the jail (after realpath, so a symlink
   * cannot lead out) is refused, as is browsing with no jail at all —
   * the fs connector could not read it either.
   */
  async browse(path: string | undefined): Promise<BrowseResponse> {
    const roots = await Promise.all(
      sourceFsRoots().map((r) => realpath(r).catch(() => resolve(r))),
    );
    if (roots.length === 0) {
      throw new BadRequestException(
        'SOURCE_FS_ROOTS is unset — the brain may not read any directory',
      );
    }
    if (!path) {
      return {
        path: '',
        parent: null,
        roots,
        folders: roots.map((r) => ({ name: r, path: r })),
        files: 0,
        truncated: false,
      };
    }
    const real = await realpath(resolve(path)).catch(() => {
      throw new BadRequestException(`no such directory: ${path}`);
    });
    const inside = roots.some((r) => real === r || real.startsWith(`${r}${sep}`));
    if (!inside) throw new BadRequestException(`${path} is outside SOURCE_FS_ROOTS`);
    const entries = await readdir(real, { withFileTypes: true });
    const folders: Array<{ name: string; path: string }> = [];
    let files = 0;
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || BROWSE_SKIP.has(e.name)) continue;
      if (e.isDirectory()) folders.push({ name: e.name, path: `${real}${sep}${e.name}` });
      else if (e.isFile()) files++;
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    const atRoot = roots.includes(real);
    return {
      path: real,
      parent: atRoot ? '' : dirname(real),
      roots,
      folders: folders.slice(0, BROWSE_MAX),
      files,
      truncated: folders.length > BROWSE_MAX,
    };
  }
}

interface RawAgent {
  agentId: string;
  firstSeenAt: unknown;
  lastSeenAt: unknown;
  version?: string | null;
  hostname?: string | null;
  platform?: string | null;
  inventory?: {
    roots?: Array<{ path: string; folders: string[] }>;
    databases?: string[];
  } | null;
}

function toAgent(r: RawAgent): SourceAgent {
  const iso = (v: unknown) => {
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  };
  return {
    agentId: r.agentId,
    firstSeenAt: iso(r.firstSeenAt),
    lastSeenAt: iso(r.lastSeenAt),
    version: r.version ?? null,
    hostname: r.hostname ?? null,
    platform: r.platform ?? null,
    roots: (r.inventory?.roots ?? []).map((x) => ({
      path: String(x.path),
      folders: Array.isArray(x.folders) ? x.folders.map(String) : [],
    })),
    databases: Array.isArray(r.inventory?.databases) ? r.inventory.databases.map(String) : [],
  };
}

/** Exposed for tests: the name a picker shows for a root. */
export function rootLabel(path: string): string {
  return basename(path) || path;
}
