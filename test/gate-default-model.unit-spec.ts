/**
 * Code-memory track C — regression guard for the SHIPPED default gate model
 * (models/decision-gate.model.json). The committed model, wrapped in the hybrid
 * (heuristic OR model), must beat the pure heuristic on the frozen human-labeled
 * golden and never lose precision. This is the quality bar the default gate
 * commits to; a bad retrain that regresses here fails CI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TrainedDecisionClassifier } from '../src/code-memory/capture/gate-classifier';
import { HybridDecisionClassifier } from '../src/code-memory/capture/hybrid-classifier';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import {
  evaluateClassifierOnGolden,
  evaluateHeuristicOnGolden,
} from '../src/code-memory/capture/gate-golden';

const MODEL_PATH = join(__dirname, '..', 'models', 'decision-gate.model.json');

// Ratchet: the shipped hybrid currently scores golden F1 0.6667 (prec 1.0, rec
// 0.5). "Beats the heuristic" (0.621) alone is too loose a guard — a retrain
// could silently regress to e.g. 0.638 and still pass. Pin an absolute floor so
// a real regression fails CI. Raise this (never lower) when a better model
// ships.
const SHIPPED_GOLDEN_F1_FLOOR = 0.66;

describe('shipped default gate model', () => {
  const model = TrainedDecisionClassifier.fromJson(JSON.parse(readFileSync(MODEL_PATH, 'utf8')));

  it('loads and is a valid gate model', () => {
    // fromJson threw if invalid; a smoke classify confirms it scores.
    const v = model.classify({
      sha: 'x',
      message: 'refactor: split because args drifted between call-sites',
      changedFiles: ['src/x.ts'],
      authorDate: '2026-07-07T00:00:00Z',
    });
    expect(typeof v.likelyDecision).toBe('boolean');
  });

  it('hybrid (heuristic OR model) beats the heuristic on the golden', () => {
    const hybrid = new HybridDecisionClassifier(new HeuristicDecisionClassifier(), model);
    const h = evaluateHeuristicOnGolden();
    const hy = evaluateClassifierOnGolden(hybrid);
    // Strictly better F1, and precision never regresses — the gate's contract.
    expect(hy.f1).toBeGreaterThan(h.f1);
    expect(hy.precision).toBeGreaterThanOrEqual(h.precision);
    // The hybrid recall covers everything the heuristic caught, plus more.
    expect(hy.recall).toBeGreaterThan(h.recall);
  });

  it('holds the absolute golden F1 ratchet (catches a silent regression)', () => {
    const hybrid = new HybridDecisionClassifier(new HeuristicDecisionClassifier(), model);
    const hy = evaluateClassifierOnGolden(hybrid);
    expect(hy.f1).toBeGreaterThanOrEqual(SHIPPED_GOLDEN_F1_FLOOR);
  });
});
