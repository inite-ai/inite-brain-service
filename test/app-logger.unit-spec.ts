/**
 * The process logger (src/common/app-logger.ts): one format rule shared
 * with the request logger, and no debug chatter in production.
 */
import { appLogger } from '../src/common/app-logger';
import { useJsonLogs } from '../src/common/request-logger';

describe('appLogger', () => {
  it('follows the request logger: LOG_FORMAT wins, else JSON in production only', () => {
    expect(useJsonLogs({ LOG_FORMAT: 'json' })).toBe(true);
    expect(useJsonLogs({ LOG_FORMAT: 'text', NODE_ENV: 'production' })).toBe(false);
    expect(useJsonLogs({ NODE_ENV: 'production' })).toBe(true);
    expect(useJsonLogs({ NODE_ENV: 'development' })).toBe(false);
  });

  it('production keeps log and above; development keeps every level', () => {
    const prod = appLogger({ NODE_ENV: 'production' });
    expect(prod.isLevelEnabled('log')).toBe(true);
    expect(prod.isLevelEnabled('warn')).toBe(true);
    expect(prod.isLevelEnabled('debug')).toBe(false);
    expect(prod.isLevelEnabled('verbose')).toBe(false);
    const dev = appLogger({ NODE_ENV: 'development' });
    expect(dev.isLevelEnabled('debug')).toBe(true);
    expect(dev.isLevelEnabled('verbose')).toBe(true);
  });

  it('writes one JSON object per line with a level field when the format is JSON', () => {
    const logger = appLogger({ NODE_ENV: 'production' });
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.warn('scoped signin timed out', 'SurrealService');
    const line = String(write.mock.calls.at(-1)?.[0] ?? '').trim();
    write.mockRestore();
    const parsed = JSON.parse(line) as { level: string; message: string; context: string };
    expect(parsed).toMatchObject({
      level: 'warn',
      message: 'scoped signin timed out',
      context: 'SurrealService',
    });
  });
});
