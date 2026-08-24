/**
 * Multi-class label F1 — used for both the conflict-resolution label and
 * the retrieval-lane label (predicted label vs gold label).
 *
 * A single generic scorer covers both because the shape is identical:
 * a single-label multi-class classification. Reports:
 *   - accuracy    — share correct (== micro-F1 for single-label problems).
 *   - microF1     — pooled TP/FP/FN across labels.
 *   - macroF1     — mean of per-label F1 (each label weighted equally, so a
 *     rare "value_conflict" label can't be drowned by a common "no_conflict").
 *   - perLabel    — precision/recall/f1/support per gold label.
 *
 * Pure. null on empty input.
 */

export interface LabelRecord {
  predicted: string;
  gold: string;
}

export interface LabelClassMetrics {
  label: string;
  precision: number;
  recall: number;
  f1: number;
  /** Number of gold instances of this label. */
  support: number;
}

export interface LabelClassificationResult {
  accuracy: number;
  microF1: number;
  macroF1: number;
  perLabel: LabelClassMetrics[];
  n: number;
}

export function labelClassificationMetrics(
  records: LabelRecord[],
): LabelClassificationResult | null {
  if (records.length === 0) return null;

  const labels = new Set<string>();
  for (const r of records) {
    labels.add(r.predicted);
    labels.add(r.gold);
  }

  const perLabel: LabelClassMetrics[] = [];
  let microTp = 0;
  let microFp = 0;
  let microFn = 0;
  let f1Sum = 0;
  let labelCount = 0;

  for (const label of [...labels].sort()) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of records) {
      if (r.predicted === label && r.gold === label) tp++;
      else if (r.predicted === label && r.gold !== label) fp++;
      else if (r.predicted !== label && r.gold === label) fn++;
    }
    const support = tp + fn;
    // Skip labels that only ever appear as a wrong prediction (support 0)
    // from the macro average — they have no recall to speak of — but keep
    // their FP in the micro pool so a hallucinated label still hurts.
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    microTp += tp;
    microFp += fp;
    microFn += fn;
    if (support > 0) {
      f1Sum += f1;
      labelCount++;
    }
    perLabel.push({ label, precision, recall, f1, support });
  }

  const microPrecision = microTp + microFp === 0 ? 0 : microTp / (microTp + microFp);
  const microRecall = microTp + microFn === 0 ? 0 : microTp / (microTp + microFn);
  const microF1 =
    microPrecision + microRecall > 0
      ? (2 * microPrecision * microRecall) / (microPrecision + microRecall)
      : 0;

  const correct = records.filter((r) => r.predicted === r.gold).length;

  return {
    accuracy: correct / records.length,
    microF1,
    macroF1: labelCount === 0 ? 0 : f1Sum / labelCount,
    perLabel,
    n: records.length,
  };
}
