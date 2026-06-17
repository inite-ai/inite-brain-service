/**
 * Barrel re-export — keeps the existing import paths
 * (`import { traceSpan, TraceBufferService, DebugTraceInterceptor }
 *    from '../common/debug-trace'`)
 * working after the file was split into core / buffer / interceptor.
 *
 * The split satisfies one-class-per-file (Single Responsibility) and lets
 * tests mock the buffer or the interceptor in isolation. Keep this file
 * as pure re-exports — no logic, no types of its own. New helpers go in
 * `debug-trace-core.ts`; new persistence in `trace-buffer.service.ts`;
 * new HTTP-bound code in `debug-trace.interceptor.ts`.
 */
export {
  type DebugSpan,
  type DebugArtifact,
  type DebugContext,
  type DebugTraceSnapshot,
  getDebugContext,
  runWithDebugTrace,
  traceSpan,
  traceArtifact,
  debugTraceMiddleware,
} from './debug-trace-core';
export { TraceBufferService } from './trace-buffer.service';
export { DebugTraceInterceptor } from './debug-trace.interceptor';
