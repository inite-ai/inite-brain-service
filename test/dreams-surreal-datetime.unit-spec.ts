/**
 * surrealdb 2.2 hands datetime columns back as objects, not strings; the
 * dreams resolver sliced them and the whole nightly job failed on the
 * first competing pair (local stand, 2026-10-29).
 */
import type { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { DreamsResolverService } from '../src/dreams/resolver.service';
import { isoDay, isoString } from '../src/common/surreal-date';

/** The driver's DateTime shape: an object with toDate(), no slice(). */
const driverDate = (iso: string) => ({ toDate: () => new Date(iso), toString: () => iso });

describe('isoString / isoDay', () => {
  it('reads a string, a Date and the driver DateTime alike', () => {
    expect(isoDay('2026-03-01T10:00:00Z')).toBe('2026-03-01');
    expect(isoDay(new Date('2026-03-01T10:00:00Z'))).toBe('2026-03-01');
    expect(isoString(driverDate('2026-03-01T10:00:00.000Z'))).toBe('2026-03-01T10:00:00.000Z');
  });
});

describe('dreams resolve over driver datetimes', () => {
  it('judges a competing pair whose dates are DateTime objects, and logs no fact values', async () => {
    const row = (id: string, object: string) => ({
      id,
      entityId: 'knowledge_entity:c',
      predicate: 'favorite_color',
      object,
      confidence: 0.8,
      validFrom: driverDate('2026-03-01T00:00:00.000Z'),
      recordedAt: driverDate('2026-03-01T00:00:00.000Z'),
      source: {},
      userId: null,
    });
    const db = {
      query: async (sql: string) => {
        if (sql.includes("status = 'competing'")) {
          return [[row('knowledge_fact:a', 'blue'), row('knowledge_fact:b', 'green')]];
        }
        if (sql.includes('FROM knowledge_fact')) {
          return [
            [
              {
                predicate: 'name',
                object: 'Rohit',
                recordedAt: driverDate('2026-01-05T00:00:00.000Z'),
              },
            ],
          ];
        }
        return [[]];
      },
    } as unknown as Surreal;
    const config = {
      get: (k: string, d?: string) =>
        ({ DREAMS_RESOLVE_ENABLED: '1', OPENAI_API_KEY: 'sk', DREAMS_RESOLVE_MIN_AGE_DAYS: '0' })[
          k
        ] ?? d,
      getOrThrow: () => 'sk',
    } as unknown as ConfigService;
    const svc = new DreamsResolverService(config);
    const prompts: string[] = [];
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            prompts.push(req.messages.find((m) => m.role === 'user')!.content);
            return { choices: [{ message: { content: '{"verdict":"unsure","rationale":"x"}' } }] };
          },
        },
      },
    };
    const warn = jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const result = await svc.run(db);
    expect(result).toMatchObject({ llmJudgements: 1, unsurePairs: 1 });
    expect(prompts[0]).toContain('validFrom=2026-03-01');
    expect(prompts[0]).toContain('- [2026-01-05] name: Rohit');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/blue|green/);
  });
});
