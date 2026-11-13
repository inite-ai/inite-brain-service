import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isUpstreamFailure, rethrowDemoChatError } from '../src/admin/demo-upstream-guard';

describe('demo chat upstream guard', () => {
  const logger = { warn: jest.fn() } as unknown as Logger;

  it('turns an upstream outage into a 503 with a retry hint', () => {
    const err = Object.assign(new Error('fetch https://api.openai.com/v1: Premature close'), {
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
    expect(isUpstreamFailure(err)).toBe(true);
    try {
      rethrowDemoChatError(err, logger, '/x');
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      const body = (e as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body.reason).toBe('upstream_llm_unavailable');
      expect(body.retryAfterMs).toBe(2000);
    }
  });

  it('passes typed Nest exceptions through and rethrows anything else', () => {
    expect(() => rethrowDemoChatError(new BadRequestException('x'), logger, '/x')).toThrow(
      BadRequestException,
    );
    const plain = new Error('boom');
    expect(isUpstreamFailure(plain)).toBe(false);
    expect(() => rethrowDemoChatError(plain, logger, '/x')).toThrow(plain);
  });
});
