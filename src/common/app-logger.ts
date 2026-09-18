import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { useJsonLogs } from './request-logger';

/**
 * The process logger, configured once for NestFactory.create.
 *
 * Two things the default ConsoleLogger got wrong in production, both
 * visible in the log store: every line was ANSI-coloured text with the
 * level as a padded word, so the shipper filed the whole stream as
 * `detected_level=unknown` (only the request logger's own JSON lines
 * carried a level); and every level was on, so a 60-second capability
 * probe and the throttle sweep wrote a DEBUG line each — a quarter of
 * the boot-to-boot volume said nothing.
 *
 * The format follows the request logger's rule (LOG_FORMAT, else JSON
 * in production), so one process writes one format. Production keeps
 * `log` and above; anything else keeps every level.
 */
export function appLogger(env: NodeJS.ProcessEnv = process.env): ConsoleLogger {
  const production = env.NODE_ENV === 'production';
  const logLevels: LogLevel[] = production
    ? ['fatal', 'error', 'warn', 'log']
    : ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
  return new ConsoleLogger({ json: useJsonLogs(env), logLevels });
}
