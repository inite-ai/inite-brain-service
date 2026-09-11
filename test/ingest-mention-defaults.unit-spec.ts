/**
 * The two-line write.
 *
 * `POST /v1/ingest/mention` used to demand `contextRef` and `emittedAt`
 * on top of the text — five domain concepts before a first success,
 * against a category norm of `add("text", user_id=…)`. They are now
 * defaulted at the surface.
 *
 * The mechanism is a property initializer on the DTO, which only works
 * because the global ValidationPipe runs with `transform: true`:
 * class-transformer constructs the instance (running initializers) and
 * then assigns the supplied keys over it. That is a load-bearing
 * assumption about someone else's library, so it is tested through the
 * real pipe rather than by constructing the class directly.
 */
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const metadata = { type: 'body' as const, metatype: IngestMentionDto };
const run = (body: unknown): Promise<IngestMentionDto> =>
  pipe.transform(body, metadata) as Promise<IngestMentionDto>;

describe('POST /v1/ingest/mention — surface defaults', () => {
  it('accepts text alone', async () => {
    const dto = await run({ text: 'Maria moved to Berlin in June.' });
    expect(dto.contextRef).toEqual({ vertical: 'chat' });
    expect(Number.isNaN(Date.parse(dto.emittedAt))).toBe(false);
  });

  it('accepts text plus a user, which is the whole quickstart', async () => {
    const dto = await run({ text: 'Maria prefers morning appointments.', userId: 'user_42' });
    expect(dto.userId).toBe('user_42');
    expect(dto.contextRef.vertical).toBe('chat');
  });

  it('lets a caller that knows better win', async () => {
    const dto = await run({
      text: 'Maria moved to Berlin.',
      contextRef: { vertical: 'rent', conversationId: 'conv_1', recorder: 'crm-sync' },
      emittedAt: '2026-06-01T10:00:00Z',
    });
    expect(dto.contextRef).toEqual({
      vertical: 'rent',
      conversationId: 'conv_1',
      recorder: 'crm-sync',
    });
    expect(dto.emittedAt).toBe('2026-06-01T10:00:00Z');
  });

  it('stamps the arrival time, not a fixed date', async () => {
    const before = Date.now();
    const dto = await run({ text: 'Anything at all, long enough to be a mention.' });
    const stamped = Date.parse(dto.emittedAt);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('gives each request its own default object, not a shared one', async () => {
    // A default shared across requests would let one tenant's mutation
    // leak into the next request's contextRef.
    const a = await run({ text: 'First mention, long enough to pass validation.' });
    const b = await run({ text: 'Second mention, long enough to pass validation.' });
    expect(a.contextRef).not.toBe(b.contextRef);
  });

  it('still rejects a mention with no text', async () => {
    await expect(run({ userId: 'user_42' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still rejects a malformed emittedAt rather than silently defaulting it', async () => {
    // Defaulting an absent value is a convenience; defaulting a WRONG
    // value would be brain quietly recording the wrong event time.
    await expect(run({ text: 'Maria moved.', emittedAt: 'last tuesday' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still rejects unknown keys', async () => {
    await expect(run({ text: 'Maria moved.', vertical: 'rent' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
