import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CONFIG_CATALOG, type ConfigCatalogSpec } from './config-catalog.data';
import {
  deployValueOf,
  hasDeployValue,
  SETTINGS_ENV_ONLY,
  type StoredSettingRow,
} from '../common/platform-settings';

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
  | 'scenes'
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
  /** An operator override from `platform_setting` is standing over the deploy. */
  overridden: boolean;
  /** What the deploy's environment holds beneath the override (null = it set none). */
  deployValue?: string | null | undefined;
  /** Whether this key may be written at all — a bootstrap key is environment-only. */
  settable: boolean;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
  note?: string | null | undefined;
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
 * once at boot (constructor/module init) and an override needs a
 * restart to bite.
 *
 * The catalogue is also the WRITE contract: PlatformSettingsService will
 * only store a key that appears here, and takes `secret` from here
 * rather than from the caller. A key the operator cannot be allowed to
 * move (the database credentials, the key the store's own secrets are
 * encrypted under) is listed in SETTINGS_ENV_ONLY and reported
 * `settable: false`.
 */
@Injectable()
export class ConfigInspectorService {
  constructor(private readonly config: ConfigService) {}

  list(overrides: ReadonlyMap<string, StoredSettingRow> = new Map()): ConfigEntry[] {
    return this.catalogue().map((spec) => {
      const raw = this.config.get<string>(spec.key);
      const current = raw ?? '';
      const override = overrides.get(spec.key);
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
        overridden: override !== undefined,
        // Only meaningful under an override — and a secret's deploy value
        // is still a secret, so it is reported as presence, never read back.
        deployValue:
          override === undefined || !hasDeployValue(spec.key)
            ? undefined
            : spec.secret
              ? deployValueOf(spec.key)
                ? '••• set'
                : null
              : (deployValueOf(spec.key) ?? null),
        settable: !SETTINGS_ENV_ONLY.has(spec.key),
        updatedAt: override?.updatedAt,
        updatedBy: override?.updatedBy,
        note: override?.note,
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
