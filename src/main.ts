// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 INITE — see LICENSE in the repository root.

// OTel bootstrap MUST run before any code that imports `http`,
// `express`, or other auto-instrumented modules. The instrumentations
// patch via require-hooks; late init silently misses every prior
// require. No-op when OTEL_ENABLED!=1.
import { initTracing, shutdownTracing } from './common/tracing';
initTracing();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validateEnv } from './common/env-validation';
import { requestLogger } from './common/request-logger';
import { debugTraceMiddleware } from './common/debug-trace';
import { correlationIdMiddleware } from './common/correlation-id.middleware';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  // Fail fast on missing/invalid env before NestJS or Surreal even start.
  validateEnv();

  // Process-level crash safety. This is a long-lived worker pod with many
  // un-awaited background promises (worker poll loop, cron ticks, lease
  // renew intervals).
  //   - unhandledRejection: log and keep serving. A stray rejected promise
  //     in a background loop is usually benign and must not take the pod
  //     down (modern Node would otherwise crash on it).
  //   - uncaughtException: use the MONITOR variant — log the structured
  //     trace but DON'T swallow it, so Node still applies its default
  //     crash. After an uncaught throw the process state is undefined
  //     (a half-mutated invariant); a clean restart (restart:unless-stopped)
  //     is safer than continuing on corrupt state.
  const procLog = new Logger('Process');
  process.on('unhandledRejection', (reason) => {
    const e = reason as Error;
    procLog.error(
      `unhandledRejection: ${e?.message ?? reason}`,
      e?.stack,
    );
  });
  process.on('uncaughtExceptionMonitor', (err) => {
    procLog.error(`uncaughtException: ${err?.message ?? err}`, err?.stack);
  });

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(helmet({
    contentSecurityPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  // correlationIdMiddleware runs FIRST so the ALS store is set before
  // any other middleware (request-logger, debug-trace) reads it. The
  // emitted x-request-id header lets the caller quote the id when
  // filing a bug.
  app.use(correlationIdMiddleware());
  app.use(debugTraceMiddleware());
  app.use(requestLogger());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Catch-all filter: attaches the correlation id to every error
  // response and prevents non-HttpException internals from leaking.
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  logger.log(`INITE Brain Service running on port ${port}`);
  logger.log(`SurrealDB: ${configService.get<string>('SURREALDB_URL')}`);

  // Hard-stop guard: if a hung SurrealDB close blocks shutdown, force exit
  // after 15s rather than have docker SIGKILL us with no log line.
  const onTerm = async () => {
    logger.log('SIGTERM received — closing app');
    const t = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000).unref();
    await app.close().catch((err) => {
      logger.error(`Error during shutdown: ${(err as Error).message}`);
    });
    await shutdownTracing(); // flush OTel spans before exit
    clearTimeout(t);
    process.exit(0);
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
}

bootstrap().catch((err) => {
   
  console.error(err.message ?? err);
  process.exit(1);
});
