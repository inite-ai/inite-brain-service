/**
 * Unit coverage for AllExceptionsFilter: HttpExceptions keep their status
 * + safe message and gain a requestId; unknown errors collapse to a
 * generic 500 that never leaks the underlying message/stack.
 */
import {
  BadRequestException,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';

function mockHost(): {
  host: ArgumentsHost;
  sent: { status?: number; body?: any };
  res: { headersSent: boolean };
} {
  const sent: { status?: number; body?: any } = {};
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: any) {
      sent.body = body;
      return this;
    },
    getHeader: () => 'req-from-header',
  };
  const req = { method: 'POST', url: '/v1/search' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, sent, res };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('preserves HttpException status + message and adds requestId', () => {
    const { host, sent } = mockHost();
    filter.catch(new BadRequestException('bad query'), host);
    expect(sent.status).toBe(HttpStatus.BAD_REQUEST);
    expect(sent.body.requestId).toBe('req-from-header');
    expect(JSON.stringify(sent.body)).toContain('bad query');
  });

  it('collapses unknown errors to a generic 500 without leaking detail', () => {
    const { host, sent } = mockHost();
    filter.catch(new Error('surreal password = hunter2'), host);
    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sent.body.message).toBe('Internal server error');
    expect(sent.body.requestId).toBe('req-from-header');
    // The raw internal message must NOT reach the wire.
    expect(JSON.stringify(sent.body)).not.toContain('hunter2');
  });

  it('does NOT write when headers are already sent (streaming @Res routes)', () => {
    const { host, sent, res } = mockHost();
    res.headersSent = true;
    filter.catch(new Error('mid-stream MCP failure'), host);
    // No second write — would otherwise throw ERR_HTTP_HEADERS_SENT.
    expect(sent.status).toBeUndefined();
    expect(sent.body).toBeUndefined();
  });

  it('logs 5xx HttpExceptions but still returns their status', () => {
    const { host, sent } = mockHost();
    filter.catch(new HttpException('upstream down', HttpStatus.BAD_GATEWAY), host);
    expect(sent.status).toBe(HttpStatus.BAD_GATEWAY);
    expect(sent.body.requestId).toBe('req-from-header');
  });

  it('a 503 is a state the caller polls, not a failure: warn without a stack, answer as usual', () => {
    // Readiness during a model warmup, the embedder space guard, a
    // fail-closed admin path — every 503 is a deliberate throw whose
    // stack names the `throw` and nothing else. Logged at error it made
    // up a third of the production boot log (the edge probes /ready
    // every 3 s through a ~20 s warmup).
    const { host, sent } = mockHost();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    filter.catch(new ServiceUnavailableException({ ready: false, detail: 'embedder' }), host);
    expect(sent.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(sent.body).toMatchObject({
      ready: false,
      detail: 'embedder',
      requestId: 'req-from-header',
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    error.mockRestore();
    warn.mockRestore();
  });
});
