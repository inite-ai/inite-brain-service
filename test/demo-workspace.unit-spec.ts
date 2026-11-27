import { NotFoundException } from '@nestjs/common';
import { localAskRoute } from '../src/admin/demo-local-route';
import { DemoWorkspaceController } from '../src/admin/demo-workspace.controller';
import type { DemoChatService } from '../src/admin/demo-chat.service';
import type { DemoWorkspaceService } from '../src/admin/demo-workspace.service';
import { DEMO_ORG_ID } from '../src/demo/demo-tenant';

describe('demo workspace', () => {
  const prev = process.env.BRAIN_DEMO_WORKSPACE_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.BRAIN_DEMO_WORKSPACE_ENABLED;
    else process.env.BRAIN_DEMO_WORKSPACE_ENABLED = prev;
  });

  function controller() {
    const chat = {
      chat: jest.fn(),
      askReadOnly: jest.fn().mockResolvedValue({
        route: { mentions: [{ canonical: 'Lisbon office' }], asOf: undefined },
        strategy: 'graph',
        search: { results: [] },
      }),
    };
    const workspace = { graph: jest.fn().mockResolvedValue({ entities: [] }) };
    const c = new DemoWorkspaceController(
      workspace as unknown as DemoWorkspaceService,
      chat as unknown as DemoChatService,
    );
    return { c, chat, workspace };
  }

  it('is an absent route (404) unless enabled', async () => {
    delete process.env.BRAIN_DEMO_WORKSPACE_ENABLED;
    const { c, chat, workspace } = controller();
    await expect(c.graph()).rejects.toThrow(NotFoundException);
    await expect(c.chat({ message: 'who?' })).rejects.toThrow(NotFoundException);
    expect(chat.askReadOnly).not.toHaveBeenCalled();
    expect(workspace.graph).not.toHaveBeenCalled();
  });

  it('chat reads the demo tenant through the read-only ask, never the tell path', async () => {
    process.env.BRAIN_DEMO_WORKSPACE_ENABLED = '1';
    const { c, chat } = controller();
    const out = await c.chat({ message: 'Ana moved to Lisbon yesterday' });
    expect(chat.chat).not.toHaveBeenCalled();
    expect(chat.askReadOnly).toHaveBeenCalledWith({
      message: 'Ana moved to Lisbon yesterday',
      tenant: DEMO_ORG_ID,
      scopes: ['brain:read'],
    });
    expect(out).toMatchObject({ strategy: 'graph', mentions: ['Lisbon office'] });
  });

  it('has no write route: graph and chat only', () => {
    const own = Object.getOwnPropertyNames(DemoWorkspaceController.prototype).filter(
      (n) => n !== 'constructor',
    );
    expect(own.sort()).toEqual(['chat', 'graph']);
  });

  it('the local route is always an ask, with mentions from the known names only', () => {
    const route = localAskRoute(
      'Remember: Bruno leads the Lisbon office',
      ['Bruno Demo', 'Lisbon office'],
      new Date('2026-11-08T00:00:00Z'),
    );
    expect(route.intent).toBe('ask');
    expect(route.mentions.map((m) => m.canonical).sort()).toEqual(['Bruno Demo', 'Lisbon office']);
    expect(route.predicateHints).toEqual([]);
  });
});
