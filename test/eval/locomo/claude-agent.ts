/**
 * Claude-MCP-based QaAgent.
 *
 * Drives brain through MCP transport with Anthropic's tool-use loop.
 * One QA question → up to maxTurns rounds of Claude calling brain
 * tools (search_multi_hop, get_entity_profile, synthesize, …) → final
 * natural-language answer.
 *
 * Versus createHttpQaAgent: this is the agent-level number — Claude
 * gets agency to decompose, retry, and choose tools. The HTTP agent
 * is the lower-bound baseline (one shot through multi-hop +
 * synthesize). The gap between them is the value of agentic
 * reasoning on top of brain's retrieval stack.
 *
 * Cost: ~$30 of Claude calls + ~$80 of brain-side OpenAI (extraction +
 * synthesizer) for a full LoCoMo-10 run. Skipped from CI; run
 * explicitly from scripts/run-locomo.ts --agent claude-mcp.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { QaAgent } from './runner';

export interface ClaudeMcpAgentOptions {
  /** Anthropic model name. Default claude-sonnet-4-6. */
  model?: string;
  /** Max tool-use loop turns per question. Default 6. */
  maxTurns?: number;
  /** Max tokens per Claude response. Default 1024. */
  maxTokens?: number;
  /** System prompt prefix. */
  system?: string;
}

const DEFAULT_SYSTEM = `You are a long-term memory assistant backed by a knowledge graph (brain).
You answer the user's question using ONLY the tools provided to retrieve evidence
from the graph. Do not invent facts. If the tools return nothing relevant, say
"I don't know". Keep the final answer to ≤ 25 words.`;

interface ToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

/**
 * Construct a Claude-MCP QaAgent. Closes the MCP transport between
 * calls is not safe because Anthropic's tool_use returns a tool_id
 * that must reach the next tool_result on the same conversation —
 * we keep ONE transport per agent instance for the run lifetime and
 * close it when the runner finishes.
 */
export async function createClaudeMcpAgent(opts: {
  brainUrl: string;
  companyId: string;
  apiKey: string;
  anthropicApiKey: string;
  options?: ClaudeMcpAgentOptions;
}): Promise<{ agent: QaAgent; close: () => Promise<void> }> {
  const o = opts.options ?? {};
  const model = o.model ?? 'claude-sonnet-4-6';
  const maxTurns = o.maxTurns ?? 6;
  const maxTokens = o.maxTokens ?? 1024;
  const system = o.system ?? DEFAULT_SYSTEM;

  const transport = new StreamableHTTPClientTransport(
    new URL(`${opts.brainUrl.replace(/\/$/, '')}/mcp/${opts.companyId}`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${opts.apiKey}` },
      },
    },
  );
  const mcp = new McpClient({ name: 'locomo-claude', version: '0.1.0' });
  await mcp.connect(transport);

  const toolsList = await mcp.listTools();
  const tools: ToolDef[] = toolsList.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  const anthropic = new Anthropic({ apiKey: opts.anthropicApiKey });

  const agent: QaAgent = {
    async answer({ question, asOf }) {
      const messages: Array<Anthropic.MessageParam> = [
        {
          role: 'user',
          content:
            asOf !== undefined
              ? `Question (as of ${asOf}): ${question}`
              : question,
        },
      ];

      let lastText = '';
      for (let turn = 0; turn < maxTurns; turn++) {
        const res = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          tools: tools as Anthropic.Tool[],
          messages,
        });

        // Collect all text blocks the model emitted this turn.
        const textBlocks = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
        if (textBlocks) lastText = textBlocks;

        const toolUses = res.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (res.stop_reason === 'end_turn' || toolUses.length === 0) {
          return lastText;
        }

        // Push the assistant's response, then resolve each tool_use
        // by calling brain through MCP and shipping the tool_result.
        messages.push({ role: 'assistant', content: res.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          try {
            const toolOut = await mcp.callTool({
              name: use.name,
              arguments: use.input as Record<string, unknown>,
            });
            const text = extractText(toolOut as unknown as ToolOutShape);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: text,
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Error: ${(err as Error).message}`,
              is_error: true,
            });
          }
        }
        messages.push({ role: 'user', content: toolResults });
      }
      // maxTurns exhausted — return whatever text the model last
      // produced, even if it was reaching for another tool.
      return lastText;
    },
  };

  const close = async () => {
    try {
      await mcp.close();
    } catch {
      // ignore — transport teardown is best-effort.
    }
    try {
      await transport.close();
    } catch {
      // ignore
    }
  };

  return { agent, close };
}

interface ToolOutShape {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}

function extractText(out: ToolOutShape): string {
  // Brain wraps every tool response in `content: [{type:'text', text:JSON}]`
  // plus a `structuredContent` blob with the parsed payload. Prefer the
  // text channel — that's what the model sees in vendor docs — and
  // fall back to JSON-stringifying the structured payload.
  const textBlocks = (out.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
  if (textBlocks) return textBlocks;
  if (out.structuredContent !== undefined) {
    return JSON.stringify(out.structuredContent);
  }
  return '';
}
