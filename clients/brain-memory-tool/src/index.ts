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
 * Commands answer with the reference implementation's strings
 * (memory_20250818). `run()` returns `{ content, is_error }` for the
 * tool_result block; `handle()` returns just the text. Neither throws:
 * an exception inside an agent loop would end the turn, while an error
 * the model can read lets it recover.
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
  | { command: 'str_replace'; path: string; old_str: string; new_str?: string }
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
const MEMORY_ROOT = '/memories';

const MAX_LINES = 999_999;

interface ListedFile {
  path: string;
  size: number;
}

class BrainMemoryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class BrainMemory {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: BrainMemoryOptions) {
    if (!options.apiKey) throw new Error('brain memory: apiKey is required');
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE);
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
          res.status,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async read(path: string): Promise<MemoryFile | null> {
    try {
      return await this.call<MemoryFile>('/v1/memory-files/read', 'POST', { path });
    } catch (error) {
      if (error instanceof BrainMemoryError && error.status === 404) return null;
      throw error;
    }
  }

  private write(path: string, content: string): Promise<MemoryFile> {
    return this.call<MemoryFile>('/v1/memory-files', 'PUT', { path, content });
  }

  private list(prefix: string): Promise<{ paths: string[]; files?: ListedFile[] }> {
    return this.call('/v1/memory-files/list', 'POST', { prefix });
  }

  /**
   * Run one memory-tool command and return the tool result's text. Never
   * throws: the model is the caller, and a thrown error inside a tool
   * dispatch ends the turn instead of letting it recover. Use `run()` to
   * also get `is_error` for the tool_result block.
   */
  async handle(input: MemoryCommand): Promise<string> {
    return (await this.run(input)).content;
  }

  /** The command's result as a tool_result wants it: the text, and whether it is an error. */
  async run(input: MemoryCommand): Promise<{ content: string; is_error: boolean }> {
    try {
      return { content: await this.dispatch(input), is_error: false };
    } catch (error) {
      // The reference messages are returned as written; anything else
      // (a transport failure) is prefixed so the model reads it as one.
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: error instanceof BrainMemoryError && error.status === undefined ? message : `Error: ${message}`,
        is_error: true,
      };
    }
  }

  private async dispatch(input: MemoryCommand): Promise<string> {
    switch (input.command) {
      case 'view':
        return this.view(input);
      case 'create':
        // The tool's description says create "creates or overwrites";
        // overwriting is an implementation choice the reference allows.
        await this.write(input.path, input.file_text);
        return `File created successfully at: ${input.path}`;
      case 'str_replace':
        return this.strReplace(input);
      case 'insert':
        return this.insert(input);
      case 'delete':
        return this.delete(input.path);
      case 'rename':
        return this.rename(input.old_path, input.new_path);
      default: {
        const unknown = input as { command?: string };
        throw new BrainMemoryError(`Error: unknown command ${String(unknown.command)}`);
      }
    }
  }

  /**
   * A directory listing or a numbered file, in the reference format
   * (memory_20250818): a header line, then `size<TAB>path` for a
   * directory, or 6-wide right-aligned line numbers and a tab for a file.
   * `insert` addresses lines by the numbers `view` printed.
   */
  private async view(input: { path: string; view_range?: [number, number] }): Promise<string> {
    const root = trimTrailingSlashes(input.path) === MEMORY_ROOT;
    // A path is a directory when anything lives under it, and the root is
    // one even before anything does: a fresh store's first view lists it.
    const listing = await this.list(input.path).catch(() => null);
    const files = listing?.files ?? listing?.paths.map((path) => ({ path, size: 0 })) ?? [];
    const inside = files.filter((f) => f.path !== input.path);
    if (root || inside.length > 0) {
      const dir = trimTrailingSlashes(input.path);
      const depth = (p: string) => p.slice(dir.length).split('/').filter(Boolean).length;
      const shown = inside.filter((f) => depth(f.path) <= 2);
      const total = inside.reduce((n, f) => n + f.size, 0);
      return [
        `Here're the files and directories up to 2 levels deep in ${dir}, excluding hidden items and node_modules:`,
        `${humanSize(total)}\t${dir}`,
        ...shown.map((f) => `${humanSize(f.size)}\t${f.path}`),
      ].join('\n');
    }
    const file = await this.read(input.path);
    if (!file) throw new BrainMemoryError(`The path ${input.path} does not exist. Please provide a valid path.`);
    const lines = file.content.replace(/\n$/, '').split('\n');
    if (lines.length > MAX_LINES) {
      throw new BrainMemoryError(`File ${input.path} exceeds maximum line limit of 999,999 lines.`);
    }
    const [from, to] = input.view_range ?? [1, lines.length];
    const start = Math.max(1, from);
    const end = to === -1 ? lines.length : Math.min(lines.length, to);
    const numbered = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(6)}\t${line}`);
    return [`Here's the content of ${input.path} with line numbers:`, ...numbered].join('\n');
  }

  private async existing(path: string): Promise<MemoryFile> {
    const file = await this.read(path);
    if (!file) throw new BrainMemoryError(`Error: The path ${path} does not exist. Please provide a valid path.`);
    return file;
  }

  private async strReplace(input: {
    path: string;
    old_str: string;
    new_str?: string;
  }): Promise<string> {
    const file = await this.existing(input.path);
    const at = file.content.indexOf(input.old_str);
    if (at === -1) {
      throw new BrainMemoryError(
        `No replacement was performed, old_str \`${input.old_str}\` did not appear verbatim in ${input.path}.`,
      );
    }
    // The tool's own contract: an ambiguous edit is refused rather than
    // guessed at, because the model can disambiguate and a wrong guess
    // silently corrupts its notes.
    const lines = occurrenceLines(file.content, input.old_str);
    if (lines.length > 1) {
      throw new BrainMemoryError(
        `No replacement was performed. Multiple occurrences of old_str \`${input.old_str}\` in lines: ${lines.join(', ')}. Please ensure it is unique`,
      );
    }
    // Spliced by index, not String.replace: a replacement string there
    // reads `$&`, `$$` and `` $` `` as patterns and corrupts text holding them.
    const next =
      file.content.slice(0, at) + (input.new_str ?? '') + file.content.slice(at + input.old_str.length);
    await this.write(input.path, next);
    return 'The memory file has been edited.';
  }

  private async insert(input: {
    path: string;
    insert_line: number;
    insert_text: string;
  }): Promise<string> {
    const file = await this.read(input.path);
    if (!file) throw new BrainMemoryError(`Error: The path ${input.path} does not exist`);
    const lines = file.content.split('\n');
    if (input.insert_line < 0 || input.insert_line > lines.length) {
      throw new BrainMemoryError(
        `Error: Invalid \`insert_line\` parameter: ${input.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`,
      );
    }
    lines.splice(input.insert_line, 0, input.insert_text.replace(/\n$/, ''));
    await this.write(input.path, lines.join('\n'));
    return `The file ${input.path} has been edited.`;
  }

  private async delete(path: string): Promise<string> {
    if (trimTrailingSlashes(path) === MEMORY_ROOT) {
      throw new BrainMemoryError(`Error: The ${MEMORY_ROOT} directory itself cannot be deleted`);
    }
    try {
      await this.call('/v1/memory-files/delete', 'POST', { path });
    } catch (error) {
      if (error instanceof BrainMemoryError && error.status === 404) {
        throw new BrainMemoryError(`Error: The path ${path} does not exist`);
      }
      throw error;
    }
    return `Successfully deleted ${path}`;
  }

  private async rename(from: string, to: string): Promise<string> {
    if (trimTrailingSlashes(from) === MEMORY_ROOT) {
      throw new BrainMemoryError(`Error: The ${MEMORY_ROOT} directory itself cannot be renamed`);
    }
    if (!(await this.read(from))) throw new BrainMemoryError(`Error: The path ${from} does not exist`);
    // The reference never overwrites: a rename onto an existing file is an
    // error the model can resolve, not a silent loss of that file.
    if (await this.read(to)) throw new BrainMemoryError(`Error: The destination ${to} already exists`);
    await this.call('/v1/memory-files/rename', 'POST', { path: from, newPath: to });
    return `Successfully renamed ${from} to ${to}`;
  }
}

/** The 1-based line numbers where `needle` starts in `text`. */
function occurrenceLines(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    out.push(text.slice(0, at).split('\n').length);
  }
  return out;
}

/** `5.5K`-style size, as the directory view shows it. */
function humanSize(chars: number): string {
  if (chars < 1024) return `${chars}`;
  const units = ['K', 'M', 'G'];
  let n = chars / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n.toFixed(1)}${units[u]}`;
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

/** A loop, not `/\/+$/`: that regex is quadratic on a run of slashes (CodeQL js/polynomial-redos). */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
