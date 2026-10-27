import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 4369–4452 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_08: ConfigCatalogSpec[] = [
  // ── Marketplace billing (paid packs, migration 0066) ─────
  {
    key: 'DOMAIN_PACK_BILLING_ENABLED',
    category: 'billing',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Paid-pack marketplace integration with the central billing service. Off (default) = self-hosted posture: paid metadata is ignored, every pack installs free.',
  },
  {
    key: 'BILLING_SERVICE_URL',
    category: 'billing',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Base URL of the billing service (e.g. https://billing.inite.ai). Required while the billing flag is on — validated at boot.',
  },
  {
    key: 'BILLING_SERVICE_API_KEY',
    category: 'billing',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'Service API key (x-api-key header) identifying brain as a registered Service in the billing admin.',
  },
  {
    key: 'BILLING_TIMEOUT_MS',
    category: 'billing',
    defaultValue: '5000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Per-request budget for billing HTTP calls; reads (entitlements, product list) get one retry on timeout/network/5xx.',
  },
  {
    key: 'BILLING_ENTITLEMENT_CACHE_TTL_MS',
    category: 'billing',
    defaultValue: '60000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'In-memory TTL for per-company entitlement lookups. Never served stale: expired cache + billing down fails paid installs CLOSED (503).',
  },
  {
    key: 'PROCESS_ROLE',
    category: 'jobs',
    defaultValue: 'all',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Boot-only role split: all (default, single do-everything process), api (applies WORKER_LOOP_ENABLED=0 + JOB_WORKER_POOL_SIZE=0 unless set explicitly), worker (applies CHAT_ROUTE_NLI_ENABLED=false unless set). api/worker require JOBS_QUEUE_MODE=enqueue — validated at boot. See docs/operations.md "Splitting API and worker roles".',
  },
  // ── Capability probes (active monitoring) ─────────────────
  {
    key: 'CAPABILITY_PROBE_ENABLED',
    category: 'misc',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Periodically RUN each capability the service claims (scoped read, embed) and publish the result as brain_capability_probe_* — the continuous counterpart of /ready, which a deploy polls once. On by default so a forgotten flag cannot recreate a green /health over a dead read path; set 0 to disable (no timer, no series). Per pod, no leader lease. See docs/operations.md § Capability probes.',
  },
  {
    key: 'CAPABILITY_PROBE_INTERVAL_MS',
    category: 'misc',
    defaultValue: '60000',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Probe cadence, and therefore the detection-latency floor. Minimum 5000. Each tick costs one indexless LIMIT 1 read plus one embed of a four-word string — on EMBEDDER_PROVIDER=openai that embed is a real (tiny) API call, so raise this if probe traffic matters more than a 60s floor.',
  },
  {
    key: 'CAPABILITY_PROBE_TENANT',
    category: 'misc',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Canary tenant for the scoped-read probe. Unset = the first id of the known roster. One tenant, not all: the scoped session is shared by every tenant on the pod, so a per-tenant sweep would multiply series and DB load by the roster size to re-answer the same question.',
  },
];
