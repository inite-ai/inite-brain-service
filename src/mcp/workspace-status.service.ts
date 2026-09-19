import { Injectable, Optional, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { StatsService } from '../stats/stats.service';
import { TenantRegistryService } from '../auth/tenant-registry.service';
import { UserEntityService } from '../ingest/user-entity.service';

/** Personal workspaces are provisioned as `co_u_<hash>` by the auth-service. */
const PERSONAL_PREFIX = 'co_u_';

export interface WorkspaceStatus {
  companyId: string;
  displayName?: string;
  /** True for a workspace provisioned on a user's first sign-in. */
  personal: boolean;
  /** Present when the caller is a user-bound credential. */
  userId?: string;
  /**
   * Who that user is in this memory (ingest/user-entity.ts): the name
   * the memory has learned — from their own words or an onboarding
   * `name` fact — or null while it has none. Present with `userId`.
   */
  user?: { name: string | null };
  mcpUrl?: string;
  memory: {
    entities: number;
    facts: number;
    factsLast7d: number;
  };
  packsInstalled: number;
  /** What is worth doing next, most useful first. Empty = nothing pending. */
  nextSteps: string[];
}

interface StatusInput {
  companyId: string;
  scopes: readonly string[];
  userId?: string;
}

/**
 * "What am I connected to, and what is left to set up?"
 *
 * The question an agent has the moment a connection succeeds, and the
 * one nothing could answer: a fresh tenant reads as `co_u_9f2c…`, the
 * memory is empty, and neither the agent nor the person can tell whether
 * that is a working workspace or a half-finished one.
 *
 * Everything here is read-only and tenant-scoped. `nextSteps` is
 * deliberately derived rather than stored — a stored checklist goes
 * stale the moment someone does the thing outside the agent.
 */
@Injectable()
export class WorkspaceStatusService {
  private readonly logger = new Logger(WorkspaceStatusService.name);
  /**
   * "Does this workspace have a name?" is asked on every MCP request —
   * it decides whether the rename tool is registered — so it cannot be a
   * database round trip each time. 60s of staleness is invisible except
   * right after a rename, and rename() drops the entry itself.
   */
  private readonly namedCache = new Map<string, { named: boolean; until: number }>();
  private static readonly NAMED_TTL_MS = 60_000;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly stats: StatsService,
    private readonly registry: TenantRegistryService,
    @Optional() private readonly users?: UserEntityService,
  ) {}

  async status(input: StatusInput): Promise<WorkspaceStatus> {
    const [displayName, overview, packsInstalled, own] = await Promise.all([
      this.registry.displayName(input.companyId),
      this.stats.overview(input.companyId, input.scopes, input.userId),
      this.countPacks(input.companyId),
      input.userId !== undefined ? this.users?.resolve(input.companyId, input.userId) : undefined,
    ]);

    const status: WorkspaceStatus = {
      companyId: input.companyId,
      personal: input.companyId.startsWith(PERSONAL_PREFIX),
      memory: {
        entities: overview.entities,
        facts: overview.factsActive,
        factsLast7d: overview.factsLast7d,
      },
      packsInstalled,
      nextSteps: [],
    };
    if (displayName !== undefined) status.displayName = displayName;
    if (input.userId !== undefined) {
      status.userId = input.userId;
      status.user = { name: own?.named ? own.name : null };
    }
    const mcpUrl = this.mcpUrl(input.companyId);
    if (mcpUrl !== undefined) status.mcpUrl = mcpUrl;
    status.nextSteps = nextStepsFor(status, input.scopes);
    return status;
  }

  /**
   * Whether the workspace has been named. Cached, and never throws: a
   * registry blip must not decide the tool surface, and "named" is the
   * safe answer — it hides an onboarding tool rather than offering a
   * rename that would fail anyway.
   */
  async isNamed(companyId: string): Promise<boolean> {
    const cached = this.namedCache.get(companyId);
    const now = Date.now();
    if (cached && cached.until > now) return cached.named;
    let named = true;
    try {
      named = (await this.registry.displayName(companyId)) !== undefined;
    } catch (e) {
      this.logger.warn(`isNamed(${companyId}) failed: ${(e as Error).message}`);
      return true;
    }
    this.namedCache.set(companyId, { named, until: now + WorkspaceStatusService.NAMED_TTL_MS });
    return named;
  }

  /** Name the workspace and stop offering the tool that does it. */
  async rename(companyId: string, displayName: string): Promise<string> {
    await this.registry.setDisplayName(companyId, displayName);
    this.namedCache.delete(companyId);
    return displayName.trim();
  }

  private async countPacks(companyId: string): Promise<number> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const rows = await queryRows<{ count?: number }>(
          db,
          `SELECT count() AS count FROM domain_pack WHERE status = 'active' GROUP ALL`,
        );
        return Number(rows[0]?.count ?? 0);
      });
    } catch (e) {
      // A status call must not fail because one of its numbers is
      // unavailable — report zero packs and let the rest through.
      this.logger.warn(`pack count failed for ${companyId}: ${(e as Error).message}`);
      return 0;
    }
  }

  private mcpUrl(companyId: string): string | undefined {
    const base = process.env.BRAIN_PUBLIC_URL?.replace(/\/+$/, '');
    return base ? `${base}/mcp/${companyId}` : undefined;
  }
}

/**
 * The onboarding checklist, derived from what is actually true.
 *
 * Ordered by what unblocks the most: an unnamed workspace is confusing
 * forever, empty memory means the integration has not been used yet, and
 * a domain pack only pays off once something is in there.
 */
export interface WorkspaceChecklistState {
  /** Explicitly nullable: "no name yet" is the case the checklist exists for. */
  displayName?: string | undefined;
  /** The user-bound caller and what the memory calls them (null = not learned yet). */
  userId?: string | undefined;
  user?: { name: string | null } | undefined;
  personal: boolean;
  packsInstalled: number;
  memory: { entities: number; facts: number; factsLast7d: number };
}

export function nextStepsFor(status: WorkspaceChecklistState, scopes: readonly string[]): string[] {
  const steps: string[] = [];
  const canWrite = scopes.includes('brain:write');
  const canAdmin = scopes.includes('brain:admin');

  if (status.displayName === undefined) {
    steps.push(
      canWrite
        ? 'Name this workspace with `rename_workspace` — it is showing its raw tenant id.'
        : 'This workspace has no name yet; someone with brain:write can set one.',
    );
  }
  // Onboarding of the person: the memory learns who they are from
  // them, never from a credential. Until it has a name, the agent is
  // told to ask once and record the answer — the same write the user's
  // own "I'm Sasha" would make.
  if (status.userId !== undefined && status.user?.name === null) {
    steps.push(
      canWrite
        ? `The memory has not learned this user's name yet — ask how to address them once and record it: ` +
            `\`record_fact\` with entityRef {vertical: 'user', id: '${status.userId}'}, predicate 'name', userId '${status.userId}'.`
        : "The memory has not learned this user's name yet; a credential with brain:write can record it.",
    );
  }
  if (status.memory.facts === 0) {
    steps.push(
      canWrite
        ? 'Memory is empty — record something with `record_fact`, or feed a conversation to `ingest_document`.'
        : 'Memory is empty; this credential can read but not write.',
    );
  } else if (status.memory.factsLast7d === 0) {
    steps.push('Nothing has been recorded in the last 7 days — memory only helps if it is fed.');
  }
  if (status.packsInstalled === 0 && status.memory.facts > 0 && canAdmin) {
    steps.push(
      'No domain pack installed — one teaches the extractor your vocabulary and lifecycles.',
    );
  }
  if (status.personal && canAdmin) {
    steps.push(
      'This is a personal workspace; invite the rest of the team when it stops being one.',
    );
  }
  return steps;
}
