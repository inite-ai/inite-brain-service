import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CONFIG_CATALOG, type ConfigCatalogSpec } from './config-catalog.data';

export type ConfigCategory =
  | 'pipeline'
  | 'extractor'
  | 'embedder'
  | 'dreams'
  | 'compaction'
  | 'audit'
  | 'router'
  | 'search'
  | 'multihop'
  | 'calibration'
  | 'conflict'
  | 'cost'
  | 'throttle'
  | 'jobs'
  | 'auth'
  | 'registry'
  | 'billing'
  | 'misc';

export interface ConfigEntry {
  key: string;
  category: ConfigCategory;
  /** Stringified current value (or '∅' when unset and no default applies). */
  currentValue: string;
  defaultValue: string | null;
  /** Whether changing the value at runtime takes effect without restart. */
  runtimeMutable: boolean;
  /** Whether the knob is a true boolean ("0"|"1" / "true"|"false") so the UI can render a toggle. */
  isBooleanFlag: boolean;
  /** Hint for the operator. Tiny, not a full doc. */
  description?: string | undefined;
  /** Whether the current value exposes a secret (API key, etc) — masked in the UI. */
  secret?: boolean | undefined;
}

/**
 * Catalogue of operator-visible env knobs. Hard-coded list so the
 * UI gets curated descriptions + correct restart-required flags;
 * the alternative (reading process.env) would surface arbitrary
 * platform variables that aren't ours.
 *
 * NEW knobs: add an entry below. `runtimeMutable: true` means the
 * reading code re-reads process.env on each use, so a live env change
 * takes effect without a restart; `false` means the value is captured
 * once at boot (constructor/module init). There is no write endpoint —
 * the admin UI renders this as informational metadata only.
 */
@Injectable()
export class ConfigInspectorService {
  constructor(private readonly config: ConfigService) {}

  list(): ConfigEntry[] {
    return this.catalogue().map((spec) => {
      const raw = this.config.get<string>(spec.key);
      const current = raw ?? '';
      return {
        key: spec.key,
        category: spec.category,
        currentValue: spec.secret
          ? current
            ? '••• set'
            : '∅'
          : current === ''
            ? (spec.defaultValue ?? '∅')
            : current,
        defaultValue: spec.defaultValue ?? null,
        runtimeMutable: spec.runtimeMutable === true,
        isBooleanFlag: spec.isBooleanFlag === true,
        description: spec.description,
        secret: spec.secret,
      };
    });
  }

  /**
   * Compact list of (key, group). Surfaced for the cmd-K palette or
   * external integrations that just need the schema.
   */
  schema(): Array<{ key: string; category: ConfigCategory }> {
    return this.catalogue().map((s) => ({
      key: s.key,
      category: s.category,
    }));
  }

  private catalogue(): ConfigCatalogSpec[] {
    return CONFIG_CATALOG;
  }
}
