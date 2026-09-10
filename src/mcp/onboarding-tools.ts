import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkspaceStatusService } from './workspace-status.service';
import { asStructuredContent } from './structured';

export interface OnboardingToolDeps {
  workspaceStatus: WorkspaceStatusService;
}

export interface OnboardingToolContext {
  companyId: string;
  scopes: readonly string[];
  userId?: string;
  /** Whether the workspace already has a name — decides if rename is offered. */
  named: boolean;
}

/**
 * The two tools an agent needs in the minutes after a connection works.
 *
 * OAuth (or a pasted key) gets an agent as far as "I can call brain".
 * It leaves the person with a workspace whose name is a hash, memory
 * that is empty, and no way to tell whether that is the finished state.
 * These close that gap inside the conversation the person is already
 * having, instead of sending them to a dashboard.
 *
 * `rename_workspace` is registered ONLY while the workspace is unnamed,
 * so it disappears the moment it has been used. That is deliberate:
 * every tool costs context on every request for every user, and an
 * onboarding step that is done should stop being paid for. The status
 * tool stays — "what am I connected to" is a question with no expiry.
 */
export function registerOnboardingTools(opts: {
  server: McpServer;
  ctx: OnboardingToolContext;
  deps: OnboardingToolDeps;
}): void {
  const { server, ctx, deps } = opts;

  server.registerTool(
    'workspace_status',
    {
      title: 'What this connection is attached to, and what is left to set up',
      description:
        'The tenant this credential writes to (companyId, its display name, whether it is a personal workspace), what is already in its memory (entities, active facts, facts recorded in the last 7 days), how many Domain Packs are installed, and `nextSteps` — the setup actions that would actually change something, derived from that state rather than a stored checklist. Call it right after connecting, when a user asks "which workspace am I writing to?", or when memory answers look emptier than expected.',
      inputSchema: {},
    },
    async () => {
      const input: Parameters<WorkspaceStatusService['status']>[0] = {
        companyId: ctx.companyId,
        scopes: ctx.scopes,
      };
      if (ctx.userId !== undefined) input.userId = ctx.userId;
      const out = await deps.workspaceStatus.status(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  if (ctx.named || !ctx.scopes.includes('brain:write')) return;

  server.registerTool(
    'rename_workspace',
    {
      title: 'Give this workspace a name',
      description:
        'Set the human name for the tenant this credential writes to — what every brain surface shows instead of the raw companyId. Offered only while the workspace is unnamed, and it stops being offered once it has one; renaming again is an operator action. This names the MEMORY workspace, not the organisation in the identity provider: other products keep their own name for the same tenant.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(80)
          .describe('What to call this workspace, 1-80 characters (e.g. "Acme support memory")'),
      },
    },
    async (args) => {
      const displayName = await deps.workspaceStatus.rename(ctx.companyId, args.name);
      const out = { companyId: ctx.companyId, displayName };
      return {
        content: [{ type: 'text', text: `Workspace ${ctx.companyId} is now "${displayName}".` }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}
