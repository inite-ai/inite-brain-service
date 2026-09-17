import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sourcePlaneEnabled } from '../common/source-plane-flags';
import type {
  AgentConnectionsListResponse,
  AgentDeltasResponse,
  BeginAgentRunRequest,
  BeginAgentRunResponse,
  FetchedItemWire,
  FinishAgentRunRequest,
  ItemDeltaWire,
  SourceSyncSummary,
} from '../contracts/source-plane/source-plane.schema';
import { JobRunService, type JobRunRow } from '../jobs/job-run.service';
import {
  AgentSyncService,
  ZERO_COUNTERS,
  type AgentRunCounters,
  type AgentRunState,
} from './agent-sync.service';
import {
  SourceConnectionService,
  toView,
  type SourceConnectionRow,
} from './source-connection.service';

/**
 * AgentRunService — the run ledger of the agent protocol. A run is a
 * `job_run` of type source_sync the AGENT begins (triggeredByActor
 * `agent:<id>`), so the Jobs cockpit shows it beside the server's own
 * runs; its state between calls — the connection, whether the walk is
 * full, the checkpoint the agent reported, the counters — rides
 * job_run.progress, and the run ends when the agent says finish (or
 * fails when the agent says so). One running agent run per connection:
 * a second `begin` is a 409, never two walks racing the same catalogue.
 *
 * Every call re-checks that the connection is an agent-host row of the
 * tenant and that the run belongs to that connection: an agent key can
 * only ever feed the connections an operator pointed at its host.
 */
@Injectable()
export class AgentRunService {
  constructor(
    private readonly jobs: JobRunService,
    private readonly connections: SourceConnectionService,
    private readonly sync: AgentSyncService,
  ) {}

  /** The connections an operator pointed at this agent host, with their pack entries. */
  async listForHost(companyId: string, host: string): Promise<AgentConnectionsListResponse> {
    assertEnabled();
    const rows = await this.connections.listRows(companyId);
    const out: AgentConnectionsListResponse['connections'] = [];
    for (const row of rows.filter((r) => r.host === host)) {
      const { source } = await this.connections.sourceContext(companyId, row);
      out.push({
        connection: toView(row),
        source: (source as Record<string, unknown> | null) ?? null,
      });
    }
    return { connections: out };
  }

  async begin(
    companyId: string,
    connectionId: string,
    req: BeginAgentRunRequest,
  ): Promise<BeginAgentRunResponse> {
    assertEnabled();
    const row = await this.loadAgentRow(companyId, connectionId, `agent:${req.agentId}`);
    if (row.status !== 'active') throw new ConflictException(`connection is ${row.status}`);
    const running = await this.jobs.list({
      companyId,
      jobType: 'source_sync',
      status: 'running',
      limit: 200,
    });
    if (running.some((j) => progressOf(j).connectionId === String(row.id))) {
      throw new ConflictException('a run of this connection is already in progress');
    }
    const full = req.full === true || row.checkpoint == null;
    const state: AgentRunState = {
      connectionId: String(row.id),
      agentId: req.agentId,
      full,
      startedAt: new Date(),
      checkpoint: null,
      counters: { ...ZERO_COUNTERS },
    };
    const job = await this.jobs.start({
      jobType: 'source_sync',
      companyId,
      triggeredBy: 'manual',
      triggeredByActor: `agent:${req.agentId}`,
      initialProgress: toProgress(state),
    });
    return {
      runId: job.runId,
      full,
      checkpoint: row.checkpoint ?? null,
      contentPolicy: row.contentPolicy,
      fetchBudget: row.fetchBudget ?? null,
    };
  }

  async deltas(
    companyId: string,
    p: { connectionId: string; runId: string; deltas: ItemDeltaWire[] },
  ): Promise<AgentDeltasResponse> {
    const { row, job, state } = await this.loadRun(companyId, p.connectionId, p.runId);
    const out = await this.sync.applyDeltas(companyId, { row, run: state, deltas: p.deltas });
    await this.jobs.updateProgress(job, toProgress(state));
    return out;
  }

  async item(
    companyId: string,
    p: { connectionId: string; runId: string; externalId: string; item: FetchedItemWire },
  ): Promise<{
    status: 'ingested' | 'deduplicated' | 'failed' | 'skipped';
    error?: string | undefined;
  }> {
    const { row, job, state } = await this.loadRun(companyId, p.connectionId, p.runId);
    const out = await this.sync.ingestItem(companyId, {
      row,
      run: state,
      externalId: p.externalId,
      item: p.item,
    });
    await this.jobs.updateProgress(job, toProgress(state));
    return out;
  }

  async finish(
    companyId: string,
    p: { connectionId: string; runId: string; req: FinishAgentRunRequest },
  ): Promise<SourceSyncSummary> {
    const { row, job, state } = await this.loadRun(companyId, p.connectionId, p.runId);
    const summary = await this.sync.finish(companyId, { row, run: state, req: p.req });
    await this.jobs.finish(job, {
      status: p.req.status,
      result: summary as unknown as Record<string, unknown>,
      ...(p.req.error ? { error: { message: p.req.error } } : {}),
    });
    return summary;
  }

  private async loadAgentRow(
    companyId: string,
    connectionId: string,
    host: string,
  ): Promise<SourceConnectionRow> {
    const row = await this.connections.load(companyId, connectionId);
    if (row.host !== host) {
      throw new NotFoundException(`connection ${connectionId} is not hosted on ${host}`);
    }
    return row;
  }

  private async loadRun(
    companyId: string,
    connectionId: string,
    runId: string,
  ): Promise<{ row: SourceConnectionRow; job: JobRunRow; state: AgentRunState }> {
    assertEnabled();
    const job = await this.jobs.get(runId, companyId);
    if (!job || job.jobType !== 'source_sync') {
      throw new NotFoundException(
        `run ${runId} not found (job persistence must be on for agent runs)`,
      );
    }
    if (job.status !== 'running') throw new ConflictException(`run ${runId} is ${job.status}`);
    const state = fromProgress(job);
    const row = await this.connections.load(companyId, connectionId);
    if (state.connectionId !== String(row.id)) {
      throw new NotFoundException(`run ${runId} does not belong to connection ${connectionId}`);
    }
    if (row.host !== `agent:${state.agentId}`) {
      throw new NotFoundException(
        `connection ${connectionId} is no longer hosted on agent:${state.agentId}`,
      );
    }
    return { row, job, state };
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled()) throw new NotFoundException();
}

interface AgentRunProgress {
  connectionId?: unknown;
  agentId?: unknown;
  full?: unknown;
  startedAt?: unknown;
  checkpoint?: unknown;
  counters?: unknown;
}

function progressOf(job: JobRunRow): AgentRunProgress {
  return (job.progress ?? {}) as AgentRunProgress;
}

function toProgress(state: AgentRunState): Record<string, unknown> {
  return {
    connectionId: state.connectionId,
    agentId: state.agentId,
    full: state.full,
    startedAt: state.startedAt.toISOString(),
    checkpoint: state.checkpoint,
    counters: state.counters,
  };
}

function fromProgress(job: JobRunRow): AgentRunState {
  const p = progressOf(job);
  const counters = {
    ...ZERO_COUNTERS,
    ...((p.counters as Partial<AgentRunCounters> | undefined) ?? {}),
  };
  return {
    connectionId: String(p.connectionId ?? ''),
    agentId: String(p.agentId ?? ''),
    full: p.full === true,
    startedAt: new Date(typeof p.startedAt === 'string' ? p.startedAt : job.startedAt),
    checkpoint: (p.checkpoint as Record<string, unknown> | null | undefined) ?? null,
    counters,
  };
}
