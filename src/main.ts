// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 INITE — see LICENSE in the repository root.

// OTel bootstrap MUST run before any code that imports `http`,
// `express`, or other auto-instrumented modules. The instrumentations
// patch via require-hooks; late init silently misses every prior
// require. No-op when OTEL_ENABLED!=1.
import { initTracing } from './common/tracing';
initTracing();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validateEnv } from './common/env-validation';
import { applyProcessRole } from './common/process-role';
import { requestLogger } from './common/request-logger';
import { debugTraceMiddleware } from './common/debug-trace';
import { correlationIdMiddleware } from './common/correlation-id.middleware';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { applyProxyTrust } from './common/proxy-trust';

async function bootstrap() {
  // Fail fast on missing/invalid env before NestJS or Surreal even start.
  validateEnv();

  // PROCESS_ROLE=api|worker|all → per-role flag defaults. MUST run before
  // NestFactory.create: WORKER_LOOP_ENABLED / JOB_WORKER_POOL_SIZE /
  // CHAT_ROUTE_NLI_ENABLED are captured from the environment during module
  // init. Explicitly-set flags always win; the role fills in unset ones.
  const roleLog = new Logger('ProcessRole');
  for (const line of applyProcessRole(process.env)) roleLog.log(line);

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
    procLog.error(`unhandledRejection: ${e?.message ?? reason}`, e?.stack);
  });
  process.on('uncaughtExceptionMonitor', (err) => {
    procLog.error(`uncaughtException: ${err?.message ?? err}`, err?.stack);
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Rate limits on unauthenticated callers key on the client IP, and
  // behind a reverse proxy every request arrives from the proxy's
  // address — so without this, every anonymous caller in the world
  // shares one bucket. That is the mechanism behind the 2026-09-10
  // outage, where the health probe and the internet were counted
  // together until the edge pulled the only replica out of rotation.
  //
  // Off by default: trusting X-Forwarded-For wrongly turns a
  // client-settable header into the rate-limit key, which is worse than
  // the shared bucket. TRUST_PROXY is the operator saying how many
  // proxies are actually in front of this deployment.
  new Logger('Http').log(applyProxyTrust(app));
  // The ONLY signal handling in the process: Nest runs its shutdown
  // lifecycle once per signal and re-raises the signal when it is done.
  // GracefulShutdownService (root module) owns the readiness flip, the
  // drain, the hard-stop deadline and the OTel flush inside that
  // lifecycle — a second SIGTERM listener here ran app.close()
  // concurrently with Nest's own run of the same hooks.
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Bound the JSON body. Express defaults to 100kb, but the app installs its
  // own parser; set an explicit cap so a hostile client can't post a huge
  // payload that pins memory before any handler runs. Ingest text fits well
  // under 1mb; override via MAX_BODY_SIZE for unusual workloads.
  const maxBody = configService.get<string>('MAX_BODY_SIZE', '1mb');
  app.useBodyParser('json', { limit: maxBody });
  app.useBodyParser('urlencoded', { limit: maxBody, extended: true });

  // The only HTML this service serves is the server-rendered pack registry
  // catalogue (src/registry/registry-ui.ts) — one inline <style> block, no
  // inline scripts; everything else is JSON. Enforce a CSP that allows that
  // one page's inline styles, pins scripts/objects to same-origin/none, and
  // forbids framing. (Leaving CSP off entirely is what CodeQL flagged.)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }),
  );

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
}

bootstrap().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
