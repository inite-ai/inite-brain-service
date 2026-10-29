import { randomBytes } from 'node:crypto';
import type { HarnessWorkKind } from './harness-work-token';

/**
 * One batch of deferred work handed to the connected agent in harness mode
 * (#819): the exact prompt the server's own model would have been sent,
 * the JSON schema of the reply, and the signed token the reply is
 * submitted with. Every kind is applied by the server's own code on
 * submit — the agent supplies the reading, never the write.
 */
export interface HarnessWork {
  kind: HarnessWorkKind;
  token: string;
  systemPrompt: string;
  userContent: string;
  schema: Record<string, unknown>;
  /** How many documents, pairs or scenes the batch covers. */
  items: number;
  expiresAt: string;
}

/** A judging or summarising batch claims nothing; its token lives this long. */
export const BATCH_WORK_TTL_MS = 30 * 60_000;

export function workNonce(): string {
  return randomBytes(12).toString('base64url');
}

/** Expiry in epoch seconds, `ttlMs` from now. */
export function workExpiry(ttlMs: number = BATCH_WORK_TTL_MS): number {
  return Math.floor((Date.now() + ttlMs) / 1000);
}

/**
 * The batch preamble prepended to a per-item system prompt written for one
 * item at a time: the items arrive numbered, every one gets its own answer.
 */
export function batchInstructions(itemNoun: string, idPrefix: string): string {
  return (
    `BATCH: the user message holds several ${itemNoun}s, numbered ${idPrefix}1, ${idPrefix}2, …. ` +
    `Judge each one on its own, exactly as the instructions below say for one, and answer ` +
    `every ${itemNoun} once, by its number.\n\n`
  );
}
