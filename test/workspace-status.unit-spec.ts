/**
 * The onboarding checklist. It is the only part of the status payload
 * that says anything an agent should act on, and it is derived from live
 * state rather than stored — so what it says when nothing is set up, and
 * when everything is, is the behaviour worth pinning.
 */
import {
  nextStepsFor,
  WorkspaceStatusService,
  type WorkspaceChecklistState,
} from '../src/mcp/workspace-status.service';

const READ = ['brain:read'];
const WRITE = ['brain:read', 'brain:write'];
const ADMIN = ['brain:read', 'brain:write', 'brain:admin'];

const state = (over: Partial<WorkspaceChecklistState> = {}): WorkspaceChecklistState => ({
  displayName: 'Acme memory',
  personal: false,
  packsInstalled: 1,
  memory: { entities: 10, facts: 40, factsLast7d: 5 },
  ...over,
});

describe('nextStepsFor', () => {
  it('says nothing when a workspace is named, fed and equipped', () => {
    expect(nextStepsFor(state(), ADMIN)).toEqual([]);
  });

  it('leads with the name while there is none', () => {
    const steps = nextStepsFor(state({ displayName: undefined }), WRITE);
    expect(steps[0]).toContain('rename_workspace');
  });

  it('asks the caller who cannot write to fetch someone who can', () => {
    const steps = nextStepsFor(state({ displayName: undefined }), READ);
    expect(steps[0]).not.toContain('rename_workspace');
    expect(steps[0]).toContain('brain:write');
  });

  it('treats empty memory as the thing to fix, and points at the write tools', () => {
    const steps = nextStepsFor(state({ memory: { entities: 0, facts: 0, factsLast7d: 0 } }), WRITE);
    expect(steps.join(' ')).toContain('record_fact');
  });

  it('notices a workspace that stopped being fed', () => {
    const steps = nextStepsFor(
      state({ memory: { entities: 10, facts: 40, factsLast7d: 0 } }),
      WRITE,
    );
    expect(steps.join(' ')).toContain('last 7 days');
  });

  it('suggests a domain pack only once there is something to extract from', () => {
    expect(
      nextStepsFor(
        state({ packsInstalled: 0, memory: { entities: 0, facts: 0, factsLast7d: 0 } }),
        ADMIN,
      ).join(' '),
    ).not.toContain('domain pack');
    expect(nextStepsFor(state({ packsInstalled: 0 }), ADMIN).join(' ')).toContain('domain pack');
  });

  it('keeps operator-only advice away from a caller who cannot act on it', () => {
    const steps = nextStepsFor(state({ packsInstalled: 0, personal: true }), WRITE);
    expect(steps.join(' ')).not.toContain('domain pack');
    expect(steps.join(' ')).not.toContain('invite');
  });

  it('mentions the team only for a personal workspace', () => {
    expect(nextStepsFor(state({ personal: true }), ADMIN).join(' ')).toContain('personal');
    expect(nextStepsFor(state({ personal: false }), ADMIN).join(' ')).not.toContain('personal');
  });
});

describe('WorkspaceStatusService — naming', () => {
  function makeService(displayName?: string) {
    const registry = {
      displayName: jest.fn(async () => displayName),
      setDisplayName: jest.fn(async () => undefined),
    };
    const stats = { overview: jest.fn() };
    const surreal = { withCompany: jest.fn() };
    const service = new WorkspaceStatusService(surreal as never, stats as never, registry as never);
    return { service, registry };
  }

  it('caches the named check — it runs on every MCP request', async () => {
    const { service, registry } = makeService('Acme memory');
    expect(await service.isNamed('co_x')).toBe(true);
    expect(await service.isNamed('co_x')).toBe(true);
    expect(registry.displayName).toHaveBeenCalledTimes(1);
  });

  it('drops the cache on rename, so the tool disappears immediately', async () => {
    const { service, registry } = makeService(undefined);
    expect(await service.isNamed('co_x')).toBe(false);

    registry.displayName.mockResolvedValue('Named now');
    await service.rename('co_x', '  Named now  ');
    expect(registry.setDisplayName).toHaveBeenCalledWith('co_x', '  Named now  ');
    expect(await service.isNamed('co_x')).toBe(true);
  });

  it('answers "named" when the registry is unavailable, hiding the tool rather than offering a rename that would fail', async () => {
    const { service, registry } = makeService();
    registry.displayName.mockRejectedValue(new Error('registry down'));
    expect(await service.isNamed('co_x')).toBe(true);
  });
});
