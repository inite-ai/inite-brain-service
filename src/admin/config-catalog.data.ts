import type { ConfigEntry } from './config-inspector.service';
import { CATALOG_PART_01 } from './config-catalog/01-extractor';
import { CATALOG_PART_02 } from './config-catalog/02-calibration-scenes';
import { CATALOG_PART_03 } from './config-catalog/03-platform';
import { CATALOG_PART_04 } from './config-catalog/04-evidence';
import { CATALOG_PART_05 } from './config-catalog/05-evidence-pipeline';
import { CATALOG_PART_06 } from './config-catalog/06-retrieval-profile';
import { CATALOG_PART_07 } from './config-catalog/07-retrieval-dialogue-jobs';
import { CATALOG_PART_08 } from './config-catalog/08-billing-probes';

/** One catalogue row — a ConfigEntry before the live value is projected. */
export type ConfigCatalogSpec = Omit<
  ConfigEntry,
  'currentValue' | 'overridden' | 'settable' | 'deployValue' | 'updatedAt' | 'updatedBy' | 'note'
> & {
  defaultValue: string | null;
};

/**
 * Catalogue of operator-visible env knobs — ONE big declarative literal
 * by design (curated descriptions + correct restart-required flags; see
 * ConfigInspectorService). NEW knobs: add an entry to the part file
 * that holds its section (config-catalog/NN-*.ts, concatenated here in
 * order), keep the section comments. Split into parts so no file needs a
 * max-lines exemption; the service projects live values over it.
 */
export const CONFIG_CATALOG: ConfigCatalogSpec[] = [
  ...CATALOG_PART_01,
  ...CATALOG_PART_02,
  ...CATALOG_PART_03,
  ...CATALOG_PART_04,
  ...CATALOG_PART_05,
  ...CATALOG_PART_06,
  ...CATALOG_PART_07,
  ...CATALOG_PART_08,
];
