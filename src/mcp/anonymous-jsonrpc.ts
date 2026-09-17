import { PUBLIC_TOOL_NAMES } from './public-tools';

/**
 * Which JSON-RPC messages an UNAUTHENTICATED caller may have served.
 *
 * The rule the rest of this depends on: opening the door must not stop
 * the doorbell working. `initialize` and `tools/list` are answered
 * anonymously so a client that just found this server can see what it
 * is; anything that touches memory still gets the 401 challenge, which
 * is what an OAuth-capable client uses to start its flow. If everything
 * answered anonymously, no client would ever authenticate.
 *
 * Pure and body-shaped so it can be unit-tested without a request: the
 * decision is made from the parsed JSON-RPC envelope alone.
 */

/** Methods that carry no tenant data and are safe before a key. */
const ANONYMOUS_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
]);

interface JsonRpcLike {
  method?: unknown;
  params?: { name?: unknown } | unknown;
}

/**
 * True when this message may be served without a credential.
 *
 * A BATCH is anonymous only if EVERY message in it is — one gated call
 * in a batch makes the whole batch a gated call, so a caller cannot
 * smuggle a memory read behind an `initialize`.
 */
export function isAnonymousJsonRpc(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every((m) => isAnonymousJsonRpc(m));
  }
  if (typeof body !== 'object' || body === null) return false;
  const msg = body as JsonRpcLike;
  if (typeof msg.method !== 'string') return false;
  if (ANONYMOUS_METHODS.has(msg.method)) return true;
  if (msg.method !== 'tools/call') return false;
  const params = msg.params;
  if (typeof params !== 'object' || params === null) return false;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' && PUBLIC_TOOL_NAMES.includes(name);
}
