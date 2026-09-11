/**
 * Anthropic's memory tool, backed by INITE Brain.
 *
 * The memory tool (`memory_20250818`) hands a model a directory it owns
 * — view / create / str_replace / insert / delete / rename under
 * `/memories` — and leaves the storage to the developer. Every reference
 * implementation uses a local directory, which forgets on redeploy, is
 * invisible to every other surface, and is one machine's disk.
 *
 * This module is the same command surface over brain. The agent loop
 * does not change: you still pass the tool definition to the model, you
 * still dispatch `tool_use` blocks, you just call `handle()` instead of
 * touching the filesystem.
 *
 *   const memory = createBrainMemory({ apiKey: process.env.BRAIN_KEY! })
 *   // inside your tool_use dispatch:
 *   const result = await memory.handle(block.input)
 *
 * Every command returns a string, which is what the tool result block
 * wants. Errors come back as strings too, prefixed `Error:` — the model
 * reads them and retries, the same as with a filesystem backend, and an
 * exception thrown into an agent loop would just end the turn.
 */

export interface BrainMemoryOptions {
  /** A `brain_…` key, or any bearer credential brain accepts. */
  apiKey: string;
  /** Override for self-hosted deployments. */
  baseUrl?: string;
  /**
   * End-user this memory belongs to. Set it when one workspace key
   * serves several people: each gets their own `/memories`, fenced by
   * brain rather than by a path convention you have to police.
   */
  userId?: string;
  /** Milliseconds before a request is abandoned. Default 15 000. */
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** The command shapes the memory tool emits. */
export type MemoryCommand =
  | { command: 'view'; path: string; view_range?: [number, number] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

interface MemoryFile {
  path: string;
  content: string;
  updatedAt: string;
}

const DEFAULT_BASE = 'https://brain.inite.ai';
const DEFAULT_TIMEOUT = 15_000;

class BrainMemoryError extends Error {}

export class BrainMemory {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: BrainMemoryOptions) {
    if (!options.apiKey) throw new Error('brain memory: apiKey is required');
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async call<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT,
    );
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(
          this.options.userId ? { ...(body as object), userId: this.options.userId } : body,
        ),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new BrainMemoryError(
          `brain responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private read(path: string): Promise<MemoryFile> {
    return this.call<MemoryFile>('/v1/memory-files/read', 'POST', { path });
  }

  private write(path: string, content: string): Promise<MemoryFile> {
    return this.call<MemoryFile>('/v1/memory-files', 'PUT', { path, content });
  }

  private list(prefix: string): Promise<{ paths: string[] }> {
    return this.call<{ paths: string[] }>('/v1/memory-files/list', 'POST', { prefix });
  }

  /**
   * Run one memory-tool command. Never throws: the model is the caller,
   * and a thrown error inside a tool dispatch ends the turn instead of
   * letting it recover.
   */
  async handle(input: MemoryCommand): Promise<string> {
    try {
      return await this.dispatch(input);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async dispatch(input: MemoryCommand): Promise<string> {
    switch (input.command) {
      case 'view':
        return this.view(input);
      case 'create':
        await this.write(input.path, input.file_text);
        return `Created ${input.path}`;
      case 'str_replace':
        return this.strReplace(input);
      case 'insert':
        return this.insert(input);
      case 'delete':
        await this.call('/v1/memory-files/delete', 'POST', { path: input.path });
        return `Deleted ${input.path}`;
      case 'rename':
        await this.call('/v1/memory-files/rename', 'POST', {
          path: input.old_path,
          newPath: input.new_path,
        });
        return `Renamed ${input.old_path} to ${input.new_path}`;
      default: {
        const unknown = input as { command?: string };
        throw new BrainMemoryError(`unknown command: ${String(unknown.command)}`);
      }
    }
  }

  /**
   * A directory listing or a numbered file, matching the reference
   * implementation's output. The line numbers matter: `insert` addresses
   * lines by the numbers `view` printed.
   */
  private async view(input: { path: string; view_range?: [number, number] }): Promise<string> {
    // A path with no extension is treated as a directory first, and only
    // read as a file if nothing lives under it — the same guess the
    // filesystem backend makes, without a stat call to settle it.
    const asDirectory = await this.list(input.path).catch(() => null);
    if (asDirectory && asDirectory.paths.length > 0 && !asDirectory.paths.includes(input.path)) {
      return [`Directory: ${input.path}`, ...asDirectory.paths.map((p) => `- ${p}`)].join('\n');
    }
    const file = await this.read(input.path);
    const lines = file.content.split('\n');
    const [from, to] = input.view_range ?? [1, lines.length];
    const start = Math.max(1, from);
    const end = to === -1 ? lines.length : Math.min(lines.length, to);
    const numbered = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join('\n');
    return numbered;
  }

  private async strReplace(input: {
    path: string;
    old_str: string;
    new_str: string;
  }): Promise<string> {
    const file = await this.read(input.path);
    const occurrences = file.content.split(input.old_str).length - 1;
    if (occurrences === 0) {
      throw new BrainMemoryError(`no match for the given text in ${input.path}`);
    }
    // The tool's own contract: an ambiguous edit is refused rather than
    // guessed at, because the model can disambiguate and a wrong guess
    // silently corrupts its notes.
    if (occurrences > 1) {
      throw new BrainMemoryError(
        `found ${occurrences} matches in ${input.path}; include more surrounding text to make it unique`,
      );
    }
    await this.write(input.path, file.content.replace(input.old_str, input.new_str));
    return `Edited ${input.path}`;
  }

  private async insert(input: {
    path: string;
    insert_line: number;
    insert_text: string;
  }): Promise<string> {
    const file = await this.read(input.path);
    const lines = file.content.split('\n');
    if (input.insert_line < 0 || input.insert_line > lines.length) {
      throw new BrainMemoryError(
        `insert_line ${input.insert_line} is outside ${input.path} (0-${lines.length})`,
      );
    }
    lines.splice(input.insert_line, 0, input.insert_text);
    await this.write(input.path, lines.join('\n'));
    return `Inserted into ${input.path} at line ${input.insert_line}`;
  }
}

export function createBrainMemory(options: BrainMemoryOptions): BrainMemory {
  return new BrainMemory(options);
}

/**
 * The tool definition to hand the model, so a caller does not have to
 * remember the version string. Pair it with context editing (`clear_tool_uses_20250919`)
 * — that combination is the point of the memory tool.
 */
export const MEMORY_TOOL_DEFINITION = { type: 'memory_20250818', name: 'memory' } as const;
