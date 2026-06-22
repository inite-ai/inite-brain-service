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
} from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';

function mockHost(): {
  host: ArgumentsHost;
  sent: { status?: number; body?: any };
} {
  const sent: { status?: number; body?: any } = {};
  const res = {
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
  return { host, sent };
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

  it('logs 5xx HttpExceptions but still returns their status', () => {
    const { host, sent } = mockHost();
    filter.catch(
      new HttpException('upstream down', HttpStatus.BAD_GATEWAY),
      host,
    );
    expect(sent.status).toBe(HttpStatus.BAD_GATEWAY);
    expect(sent.body.requestId).toBe('req-from-header');
  });
});
