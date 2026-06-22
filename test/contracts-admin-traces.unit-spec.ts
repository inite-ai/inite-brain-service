/**
 * Wire-contract drift guard for GET /v1/admin/traces.
 */
import { TracesResponseSchema } from '../src/contracts/admin/traces.schema';
import { AdminEvalController } from '../src/admin/admin-eval.controller';
import type { TraceBufferService } from '../src/common/debug-trace';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

function makeController(): AdminEvalController {
  const traces = {
    list: (_companyId?: string) => [
      {
        requestId: 'req-1',
        ts: new Date().toISOString(),
        method: 'POST',
        path: '/v1/search',
        status: 200,
        durationMs: 42,
        companyId: 'tenant-a',
      },
      {
        requestId: 'req-2',
        ts: new Date().toISOString(),
        method: 'POST',
        path: '/v1/synthesize',
        status: 500,
        durationMs: 1200,
        companyId: 'tenant-a',
        errored: { message: 'upstream timeout', name: 'TimeoutError' },
      },
    ],
  } as unknown as TraceBufferService;
  const undef = undefined as unknown as never;
  return new AdminEvalController(undef, undef, traces);
}

describe('AdminEvalController.listTraces() — wire contract', () => {
  it('matches TracesResponseSchema', () => {
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const parsed = TracesResponseSchema.safeParse(
      makeController().listTraces(req),
    );
    if (!parsed.success) {
      throw new Error(
        `traces drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
