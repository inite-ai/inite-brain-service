import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SurrealService, queryFirst } from '../db/surreal.service';
import { pinUserScope } from '../auth/user-scope';

/**
 * File-shaped memory — the storage behind the Anthropic memory tool.
 *
 * The tool (`memory_20250818`) hands a model a directory it owns and
 * leaves the storage to the developer. This service is that storage,
 * with brain's fences applied: per-tenant database, per-user row fence
 * (0055), and a path namespace the caller cannot escape.
 *
 * The file semantics are exact on purpose. `str_replace` and `insert`
 * are string operations on the content the model last wrote, so
 * anything lossy here — normalising whitespace, re-wrapping, storing a
 * summary — breaks the agent loop in ways that look like the model
 * hallucinating its own notes. Read back exactly what was written.
 */

/** The one directory the tool is allowed to touch. */
export const MEMORY_ROOT = '/memories';
const MAX_PATH = 512;
const MAX_CONTENT = 100_000;

export interface MemoryFile {
  path: string;
  content: string;
  updatedAt: string;
}

export interface MemoryFileRef {
  companyId: string;
  path: string;
  userId?: string | undefined;
}

interface Row {
  path: string;
  content: string;
  updatedAt: string;
}

/**
 * Reject anything that is not a plain path under /memories.
 *
 * The checks are deliberately boring and all of them run: a traversal
 * that reaches the database is a cross-user read, because the row fence
 * is on (path, userId) and a crafted path is how you would forge
 * someone else's key.
 */
export function normalizeMemoryPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BadRequestException('path is required');
  }
  const path = raw.trim();
  if (path.length > MAX_PATH) {
    throw new BadRequestException(`path exceeds ${MAX_PATH} characters`);
  }
  if (!path.startsWith(MEMORY_ROOT)) {
    throw new BadRequestException(`path must start with ${MEMORY_ROOT}`);
  }
  // `/memoriesXYZ` starts with the root but is not inside it.
  if (path !== MEMORY_ROOT && !path.startsWith(`${MEMORY_ROOT}/`)) {
    throw new BadRequestException(`path must start with ${MEMORY_ROOT}/`);
  }
  if (path.includes('..') || path.includes('\0') || path.includes('//')) {
    throw new BadRequestException('path must not contain .., // or null bytes');
  }
  return path;
}

@Injectable()
export class MemoryFileService {
  constructor(private readonly surreal: SurrealService) {}

  /** One file, or 404 — the tool's `view` on a file path. */
  async read(ref: MemoryFileRef): Promise<MemoryFile> {
    const path = normalizeMemoryPath(ref.path);
    const userId = pinUserScope(ref.userId);
    const row = await this.surreal.withCompany(ref.companyId, (db) =>
      queryFirst<Row>(
        db,
        `SELECT path, content, updatedAt FROM memory_file
           WHERE path = $path AND userId ${userId === undefined ? 'IS NONE' : '= $userId'}
           LIMIT 1`,
        userId === undefined ? { path } : { path, userId },
      ),
    );
    if (!row) throw new NotFoundException(`no such memory file: ${path}`);
    return { path: row.path, content: row.content, updatedAt: String(row.updatedAt) };
  }

  /** Paths under a prefix — the tool's `view` on a directory. */
  async list(
    ref: Omit<MemoryFileRef, 'path'> & { prefix?: string | undefined },
  ): Promise<string[]> {
    const prefix = normalizeMemoryPath(ref.prefix ?? MEMORY_ROOT);
    const userId = pinUserScope(ref.userId);
    const rows = await this.surreal.withCompany(ref.companyId, async (db) => {
      const [out] = await db.query<Row[][]>(
        `SELECT path FROM memory_file
           WHERE string::starts_with(path, $prefix)
             AND userId ${userId === undefined ? 'IS NONE' : '= $userId'}
           ORDER BY path ASC
           LIMIT 1000`,
        userId === undefined ? { prefix } : { prefix, userId },
      );
      return out ?? [];
    });
    return rows.map((r) => r.path);
  }

  /** Create or replace — the tool's `create`, and the tail of every edit. */
  async write(ref: MemoryFileRef & { content: string }): Promise<MemoryFile> {
    const path = normalizeMemoryPath(ref.path);
    if (typeof ref.content !== 'string') {
      throw new BadRequestException('content must be a string');
    }
    if (ref.content.length > MAX_CONTENT) {
      throw new BadRequestException(`content exceeds ${MAX_CONTENT} characters`);
    }
    const userId = pinUserScope(ref.userId);
    const row = await this.surreal.withCompany(ref.companyId, async (db) => {
      // Explicit select-then-write rather than UPSERT … WHERE: the
      // planner drops a WHERE on a compound-index field in a way that
      // silently matches nothing (the idiom this codebase learned the
      // hard way on retrieval_feedback).
      const existing = await queryFirst<{ id: string }>(
        db,
        `SELECT id FROM memory_file
           WHERE path = $path AND userId ${userId === undefined ? 'IS NONE' : '= $userId'}
           LIMIT 1`,
        userId === undefined ? { path } : { path, userId },
      );
      if (existing) {
        return queryFirst<Row>(
          db,
          `UPDATE $id SET content = $content, updatedAt = time::now()
             RETURN path, content, updatedAt`,
          { id: existing.id, content: ref.content },
        );
      }
      // `userId` is option<string>, and a JS undefined reaches SurrealDB
      // as NULL, which an option field refuses ("expected none | string,
      // found NULL"). The workspace-wide row omits the field entirely so
      // it stays NONE — the value the (path, userId) index and every
      // `IS NONE` read above are written against.
      return userId === undefined
        ? queryFirst<Row>(
            db,
            `CREATE memory_file SET path = $path, content = $content
               RETURN path, content, updatedAt`,
            { path, content: ref.content },
          )
        : queryFirst<Row>(
            db,
            `CREATE memory_file SET path = $path, content = $content, userId = $userId
               RETURN path, content, updatedAt`,
            { path, content: ref.content, userId },
          );
    });
    if (!row) throw new BadRequestException(`could not write ${path}`);
    return { path: row.path, content: row.content, updatedAt: String(row.updatedAt) };
  }

  /** Remove one file, or every file under a directory prefix. */
  async remove(ref: MemoryFileRef): Promise<{ deleted: number }> {
    const path = normalizeMemoryPath(ref.path);
    const userId = pinUserScope(ref.userId);
    return this.surreal.withCompany(ref.companyId, async (db) => {
      // LET-select-ids → DELETE by id. A DELETE … WHERE over the
      // compound-index field deletes zero rows on this planner and says
      // nothing about it.
      const [ids] = await db.query<{ id: string }[][]>(
        `SELECT id FROM memory_file
           WHERE (path = $path OR string::starts_with(path, $dirPrefix))
             AND userId ${userId === undefined ? 'IS NONE' : '= $userId'}`,
        userId === undefined
          ? { path, dirPrefix: `${path}/` }
          : { path, dirPrefix: `${path}/`, userId },
      );
      const rows = ids ?? [];
      for (const row of rows) {
        await db.query('DELETE $id', { id: row.id });
      }
      if (rows.length === 0) throw new NotFoundException(`no such memory file: ${path}`);
      return { deleted: rows.length };
    });
  }

  /** Move a file. The destination is overwritten, matching the tool. */
  async rename(ref: MemoryFileRef & { newPath: string }): Promise<MemoryFile> {
    const from = normalizeMemoryPath(ref.path);
    const to = normalizeMemoryPath(ref.newPath);
    if (from === to) return this.read(ref);
    const current = await this.read(ref);
    const moved = await this.write({
      companyId: ref.companyId,
      path: to,
      content: current.content,
      userId: ref.userId,
    });
    await this.remove(ref);
    return moved;
  }
}
