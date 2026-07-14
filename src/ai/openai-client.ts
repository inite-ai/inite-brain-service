import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

function buildClient(config: ConfigService, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    timeout: parseInt(config.get<string>('OPENAI_TIMEOUT_MS', '30000'), 10),
    maxRetries: parseInt(config.get<string>('OPENAI_MAX_RETRIES', '3'), 10),
  });
}

/**
 * The one way to construct an OpenAI SDK client. Every service used to
 * hand-roll `new OpenAI({...})` with its own copy of the
 * OPENAI_TIMEOUT_MS / OPENAI_MAX_RETRIES parsing — 13 copies meant an
 * operator knob change had 13 chances to miss one. Returns null when
 * OPENAI_API_KEY is unset so feature-gated callers can treat "no key"
 * as feature-off; callers that REQUIRE the key use the orThrow variant.
 */
export function createOpenAiClient(config: ConfigService): OpenAI | null {
  const apiKey = config.get<string>('OPENAI_API_KEY');
  if (!apiKey) return null;
  return buildClient(config, apiKey);
}

/**
 * Required-key variant. Reads via `getOrThrow` so a missing key throws
 * Nest's canonical configuration error at construction time — the exact
 * behaviour the non-gated services (extractor, synthesize, embedder,
 * chat router, multi-hop planner) had before the consolidation.
 */
export function createOpenAiClientOrThrow(config: ConfigService): OpenAI {
  return buildClient(config, config.getOrThrow<string>('OPENAI_API_KEY'));
}
