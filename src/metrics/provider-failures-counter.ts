import { Counter, type Registry } from 'prom-client';
import { providerFailureCounts } from '../ai/provider-health';

/**
 * Failed model-provider calls since boot, read at scrape time from the
 * process-level record in src/ai/provider-health.ts (#945). Labelled by
 * capability (`embed`, `chat`) and failure class (`billing`, `key`,
 * `quota`, `outage`, `other`) only — both sets are closed, never a model,
 * a host or a tenant. `ProviderBillingOrKeyFailing` alerts on the first
 * two classes: neither heals by waiting.
 */
export function providerFailuresCounter(registry: Registry): Counter<'capability' | 'class'> {
  return new Counter({
    name: 'brain_provider_failures_total',
    help: 'Failed model-provider calls since boot, by capability (embed|chat) and class (billing|key|quota|outage|other)',
    labelNames: ['capability', 'class'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [key, n] of providerFailureCounts()) {
        const [capability = 'unknown', cls = 'other'] = key.split('|');
        this.inc({ capability, class: cls }, n);
      }
    },
  });
}
