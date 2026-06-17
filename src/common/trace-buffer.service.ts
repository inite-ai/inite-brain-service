import { Injectable } from '@nestjs/common';
import type { DebugTraceSnapshot } from './debug-trace-core';

/**
 * In-memory ring buffer of per-request debug snapshots.
 *
 * Separated from `debug-trace.ts` to honour one-class-per-file: keeps
 * the cross-cutting interceptor and the storage abstraction independently
 * mockable. The buffer caps at `capacity` entries (newest first) so a
 * long-running process can't OOM from accumulated snapshots.
 *
 * companyId-scoped reads enforce tenant isolation: a brain:admin caller
 * scoped to one tenant cannot see snapshots from another.
 */
@Injectable()
export class TraceBufferService {
  private buffer: DebugTraceSnapshot[] = [];
  private readonly capacity = 100;

  add(snapshot: DebugTraceSnapshot): void {
    this.buffer.unshift(snapshot);
    if (this.buffer.length > this.capacity) {
      this.buffer.length = this.capacity;
    }
  }

  /**
   * Operator-facing list — companyId optional so a caller with `brain:admin`
   * on a tenant key only sees their own debug traces. (The interceptor
   * already refuses to record snapshots for non-admin callers, so there is
   * no per-row ACL beyond company scoping.)
   */
  list(
    companyId?: string,
  ): Array<Omit<DebugTraceSnapshot, 'spans' | 'artifacts'>> {
    const rows = companyId
      ? this.buffer.filter((s) => s.companyId === companyId)
      : this.buffer;
    return rows.map(({ spans: _s, artifacts: _a, ...rest }) => rest);
  }

  get(requestId: string, companyId?: string): DebugTraceSnapshot | undefined {
    const hit = this.buffer.find((s) => s.requestId === requestId);
    if (!hit) return undefined;
    if (companyId && hit.companyId && hit.companyId !== companyId) {
      return undefined;
    }
    return hit;
  }
}
