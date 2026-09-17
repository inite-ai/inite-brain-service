import { DomainPackError } from './validate';
import {
  MAX_PACK_SOURCES,
  PACK_SOURCE_CONTENT_POLICIES,
  PACK_SOURCE_DELETE_POLICIES,
  PACK_SOURCE_KINDS,
  PACK_SOURCE_MCP_AUTH,
  PACK_SOURCE_SCHEDULES,
  PACK_SOURCE_SHAPES,
  type DomainPackManifest,
} from './manifest';

/**
 * Structural validation of the manifest's `sources` section (manifest.ts
 * § sources). Structural only, env-free — https-only and the private-
 * address fence for `mcp`/`http` URLs are the egress guard's job at
 * install time and again on every sync, exactly as external mcpTools.
 * A malformed section must be a clean 400 at author/install time, not a
 * sync-time surprise.
 */

const SOURCE_ID = /^[a-z][a-z0-9_]{0,39}$/;
const CONNECTOR_KIND = /^[a-z][a-z0-9_]{1,31}$/;
const KINDS = new Set<string>(PACK_SOURCE_KINDS);
const SHAPES = new Set<string>(PACK_SOURCE_SHAPES);
const CONTENT_POLICIES = new Set<string>(PACK_SOURCE_CONTENT_POLICIES);
const DELETE_POLICIES = new Set<string>(PACK_SOURCE_DELETE_POLICIES);
const SCHEDULES = new Set<string>(PACK_SOURCE_SCHEDULES);
const MCP_AUTH = new Set<string>(PACK_SOURCE_MCP_AUTH);
const MAX_STDIO_ARGS = 16;
const MAX_COMMAND_CHARS = 200;

interface SourceShape {
  id?: unknown;
  kind?: unknown;
  shape?: unknown;
  title?: unknown;
  description?: unknown;
  defaults?: unknown;
  transport?: unknown;
  url?: unknown;
  auth?: unknown;
  command?: unknown;
  args?: unknown;
  connector?: unknown;
}

export function validateSources(pack: DomainPackManifest, sources: unknown): void {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new DomainPackError(`pack "${pack.id}" sources must be a non-empty array`);
  }
  if (sources.length > MAX_PACK_SOURCES) {
    throw new DomainPackError(
      `pack "${pack.id}" declares ${sources.length} sources — max is ${MAX_PACK_SOURCES}`,
    );
  }
  const seen = new Set<string>();
  for (const raw of sources) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DomainPackError(`pack "${pack.id}" sources entries must be objects`);
    }
    const s = raw as SourceShape;
    const id = s.id;
    if (typeof id !== 'string' || !SOURCE_ID.test(id)) {
      throw new DomainPackError(
        `pack "${pack.id}" source id "${String(id)}" must match ${SOURCE_ID}`,
      );
    }
    if (seen.has(id)) {
      throw new DomainPackError(`pack "${pack.id}" declares duplicate source id "${id}"`);
    }
    seen.add(id);
    if (!KINDS.has(s.kind as string)) {
      throw new DomainPackError(
        `pack "${pack.id}" source "${id}" kind "${String(s.kind)}" must be one of ${[...KINDS].join('|')}`,
      );
    }
    if (!SHAPES.has(s.shape as string)) {
      throw new DomainPackError(
        `pack "${pack.id}" source "${id}" shape "${String(s.shape)}" must be one of ${[...SHAPES].join('|')}`,
      );
    }
    validateSourceText(pack.id, id, s);
    validateSourceDefaults(pack.id, id, s.defaults);
    if (s.kind === 'mcp') validateMcpSource(pack.id, id, s);
    else if (s.kind === 'native') validateNativeSource(pack.id, id, s);
  }
}

function validateSourceText(packId: string, id: string, s: SourceShape): void {
  if (s.title !== undefined && (typeof s.title !== 'string' || s.title.length > 80)) {
    throw new DomainPackError(
      `pack "${packId}" source "${id}" title must be a string of at most 80 characters`,
    );
  }
  if (
    s.description !== undefined &&
    (typeof s.description !== 'string' || s.description.length > 500)
  ) {
    throw new DomainPackError(
      `pack "${packId}" source "${id}" description must be a string of at most 500 characters`,
    );
  }
}

function validateSourceDefaults(packId: string, id: string, defaults: unknown): void {
  if (defaults === undefined) return;
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new DomainPackError(`pack "${packId}" source "${id}" defaults must be an object`);
  }
  const d = defaults as { contentPolicy?: unknown; deletePolicy?: unknown; schedule?: unknown };
  const check = (field: string, value: unknown, allowed: Set<string>) => {
    if (value !== undefined && !allowed.has(value as string)) {
      throw new DomainPackError(
        `pack "${packId}" source "${id}" defaults.${field} must be one of ${[...allowed].join('|')}`,
      );
    }
  };
  check('contentPolicy', d.contentPolicy, CONTENT_POLICIES);
  check('deletePolicy', d.deletePolicy, DELETE_POLICIES);
  check('schedule', d.schedule, SCHEDULES);
}

function validateMcpSource(packId: string, id: string, s: SourceShape): void {
  if (s.transport === 'http') {
    // A pinned URL must parse; an absent one means the operator names
    // the server on the connection. http accepted here so the validator
    // stays env-free; https-only is the egress guard's call (the
    // mcpTools precedent).
    if (s.url !== undefined) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(s.url as string);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        throw new DomainPackError(
          `pack "${packId}" source "${id}" url must be a valid http(s) URL`,
        );
      }
    }
    if (!MCP_AUTH.has(s.auth as string)) {
      throw new DomainPackError(
        `pack "${packId}" source "${id}" auth must be one of ${[...MCP_AUTH].join('|')}`,
      );
    }
    return;
  }
  if (s.transport === 'stdio') {
    if (
      typeof s.command !== 'string' ||
      s.command.length === 0 ||
      s.command.length > MAX_COMMAND_CHARS
    ) {
      throw new DomainPackError(
        `pack "${packId}" source "${id}" command must be a non-empty string of at most ${MAX_COMMAND_CHARS} characters`,
      );
    }
    if (s.args !== undefined) {
      if (
        !Array.isArray(s.args) ||
        s.args.length > MAX_STDIO_ARGS ||
        s.args.some((a) => typeof a !== 'string' || a.length > MAX_COMMAND_CHARS)
      ) {
        throw new DomainPackError(
          `pack "${packId}" source "${id}" args must be at most ${MAX_STDIO_ARGS} strings of at most ${MAX_COMMAND_CHARS} characters`,
        );
      }
    }
    return;
  }
  throw new DomainPackError(`pack "${packId}" source "${id}" transport must be "http" or "stdio"`);
}

function validateNativeSource(packId: string, id: string, s: SourceShape): void {
  if (typeof s.connector !== 'string' || !CONNECTOR_KIND.test(s.connector)) {
    throw new DomainPackError(
      `pack "${packId}" source "${id}" connector must match ${CONNECTOR_KIND}`,
    );
  }
}
