/**
 * OpenTelemetry bootstrap.
 *
 * Wired BEFORE NestJS in `main.ts` so that the auto-instrumentations
 * for `http` / `express` / `pg` / `dns` / etc. patch their targets
 * before user code requires them. Late initialisation is silently
 * a no-op in OTel — instrumentations attach via require-hooks that
 * have to run first.
 *
 * Gating: `OTEL_ENABLED=1`. When unset/false, `initTracing()` is a
 * cheap no-op — no SDK, no exporter, no perf cost. The tracer
 * obtained via `getTracer()` becomes a no-op tracer in that case
 * (the OTel API guarantees this), so `withSpan(...)` calls in hot
 * paths stay on the same code path; they just don't emit anything.
 *
 * Exporter: OTLP/HTTP. Endpoint defaults to the OTLP standard env
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (the SDK reads it itself). Service
 * name defaults to `inite-brain-service`; override via
 * `OTEL_SERVICE_NAME` (also a standard OTel env).
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { traceSpan as debugTraceSpan } from './debug-trace';

const TRACER_NAME = 'inite-brain-service';

// Lazy import — request-context has no runtime deps. We re-export the
// reader as a small wrapper so a test that mocks the module's getter
// can do so without touching tracing.ts internals.
import { getCorrelationId } from './request-context';
function getCorrelationIdSafe(): string | undefined {
  try {
    return getCorrelationId();
  } catch {
    return undefined;
  }
}

let sdk: NodeSDK | null = null;

export function initTracing(): void {
  if (process.env.OTEL_ENABLED !== '1') return;
  if (sdk) return;

  const serviceName =
    process.env.OTEL_SERVICE_NAME ?? 'inite-brain-service';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter(),
    // Auto-instrumentations cover http/https (so OpenAI + JWKS calls),
    // express (NestJS underlying), dns. We disable fs because it's
    // extremely noisy (every require() emits spans) and pg which we
    // don't run. Per-instrumentation knobs documented on the package.
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-pg': { enabled: false },
      }),
    ],
  });
  sdk.start();

  process.on('SIGTERM', () => {
    void shutdownTracing();
  });
}

/**
 * Flush + shut down the OTel SDK. Called from the app's graceful
 * shutdown (main.ts onTerm) so spans are exported before exit, and from
 * the SIGTERM listener above. Idempotent no-op when tracing is disabled.
 */
export async function shutdownTracing(): Promise<void> {
  const s = sdk;
  sdk = null;
  if (s) await s.shutdown().catch(() => undefined);
}

/**
 * Wrap an async fn in a span. Pure helper so call sites don't have
 * to repeat the start/setStatus/end ceremony. Sets ERROR status and
 * records the exception when the inner fn throws, then re-throws so
 * the caller's error handling stays unchanged.
 *
 * `attrs` are set on the span eagerly. Use sparingly — high-cardinality
 * attributes (per-tenant ids, raw queries) bloat the trace backend.
 * For tenant scoping, prefer setting one `companyId` attribute on the
 * outermost request span (already done by the http instrumentation
 * when it sees the auth header) and letting child spans inherit.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    // Tag every span with the active request id so OTel viewers can
    // pivot from a single log line to its full waterfall. Reads from
    // the request-context ALS store; undefined outside a request
    // (background cron, boot) — those spans omit the attr.
    const correlationId = getCorrelationIdSafe();
    if (correlationId) span.setAttribute('request.id', correlationId);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    }
    // Mirror into the per-request debug-trace buffer when an admin caller
    // attached one via the X-Brain-Debug header. No-op otherwise; this
    // is the same async-local-storage check as a bare traceSpan call.
    return debugTraceSpan(
      name,
      async () => {
        try {
          return await fn(span);
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      },
      attrs,
    );
  });
}
