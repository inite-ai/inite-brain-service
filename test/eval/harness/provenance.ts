import { execFileSync } from 'node:child_process';

/**
 * Run provenance for eval reports — "which code produced this number"
 * recorded in the artifact itself instead of tribal knowledge: the git
 * SHA (+ dirty flag, branch) of the checkout that drove the run, and
 * the resolved RetrievalProfile as reported by the brain under test
 * (GET /v1/admin/retrieval-profile — the same object every request in
 * the run was served with).
 *
 * Collection never fails a paid run: git errors degrade to 'unknown',
 * an unreachable/older brain degrades to retrievalProfile: null with
 * the error recorded.
 */

export interface GitDescriptor {
  gitSha: string;
  gitBranch: string;
  /** Uncommitted changes present — the SHA alone does not pin the code. */
  gitDirty: boolean;
}

export interface RunProvenance extends GitDescriptor {
  brainUrl: string;
  /** As reported by the brain (lanes as array); null when unavailable. */
  retrievalProfile: Record<string, unknown> | null;
  retrievalProfileError?: string;
}

export type GitExec = (args: string[]) => string;

const defaultGitExec: GitExec = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function gitDescriptor(exec: GitExec = defaultGitExec): GitDescriptor {
  let gitSha = 'unknown';
  let gitBranch = 'unknown';
  let gitDirty = false;
  try {
    gitSha = exec(['rev-parse', 'HEAD']).trim();
    gitBranch = exec(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    gitDirty = exec(['status', '--porcelain']).trim().length > 0;
  } catch {
    // Outside a repo (or git missing): report unknown, never throw.
  }
  return { gitSha, gitBranch, gitDirty };
}

export interface ProvenanceOptions {
  brainUrl: string;
  apiKey: string;
  /** X-Brain-Tenant override — only for stands with tenant override on. */
  tenant?: string;
  fetchImpl?: typeof fetch;
  gitExec?: GitExec;
}

export async function collectRunProvenance(
  opts: ProvenanceOptions,
): Promise<RunProvenance> {
  const base = gitDescriptor(opts.gitExec);
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${opts.brainUrl}/v1/admin/retrieval-profile`, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.tenant ? { 'X-Brain-Tenant': opts.tenant } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      profile?: Record<string, unknown>;
    };
    return {
      ...base,
      brainUrl: opts.brainUrl,
      retrievalProfile: body.profile ?? null,
    };
  } catch (e) {
    return {
      ...base,
      brainUrl: opts.brainUrl,
      retrievalProfile: null,
      retrievalProfileError: (e as Error).message,
    };
  }
}

/** One-line stderr form for leg logs: sha7[+dirty] branch profile-gist. */
export function formatProvenance(p: RunProvenance): string {
  const sha = p.gitSha === 'unknown' ? 'unknown' : p.gitSha.slice(0, 7);
  const prof = p.retrievalProfile
    ? `dateAnchoring=${p.retrievalProfile.dateAnchoring} ` +
      `verbatim=${p.retrievalProfile.verbatimEvidence} ` +
      `insight=${p.retrievalProfile.insightEvidence ?? 'off'} ` +
      `timeline=${p.retrievalProfile.timelineEvidence ?? 'off'} ` +
      `abstention=${p.retrievalProfile.abstentionCalibration ?? 'off'} ` +
      `lanes=[${(p.retrievalProfile.lanes as string[] | undefined)?.join(',') ?? ''}]`
    : `profile unavailable (${p.retrievalProfileError ?? 'unknown'})`;
  return `code=${sha}${p.gitDirty ? '+dirty' : ''} branch=${p.gitBranch} ${prof}`;
}
