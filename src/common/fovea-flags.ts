import { envFlagEnabled } from './env-validation';

/**
 * Fovea optics (Optics-1) master flag — FOVEA_FOCUS_CAPTURE.
 *
 * The env read lives here in the common layer, NOT inside the engine dirs
 * (src/synthesize/ takes resolved config only — engine-gates S5.2). It is
 * consumed by the synthesize focus-signal capture path and the admin
 * fit/measure surface. Read at call time so a flip is runtime-mutable (no
 * restart). Default off → serving-neutral: the capture is a guarded no-op
 * and the admin routes 404.
 */
export function focusCaptureEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_FOCUS_CAPTURE);
}

/** Default escalate cutoff on calibrated confidence (Optics-2 §4.1). */
const DEFAULT_ADAPTIVE_L3_THRESHOLD = 0.5;

/**
 * Fovea optics (Optics-2) master flag — FOVEA_ADAPTIVE_L3.
 *
 * When on AND a usable per-class calibration model is loaded, the L3
 * escalation trigger + session-count become adaptive to the calibrated
 * focus confidence (docs/roadmap/fovea-optics-2026-08.md §4.1). The env
 * read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off, AND with no calibration model present the serving path is
 * byte-identical to the static L3 — the load-bearing safety property.
 */
export function adaptiveL3Enabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_ADAPTIVE_L3);
}

/**
 * Optics-2 escalate threshold (FOVEA_ADAPTIVE_L3_THRESHOLD): escalate to
 * L3 when calibrated confidence < this value, and scale #sessions ∝ the
 * deficit below it. A non-boolean knob resolved here in the common layer
 * so the engine dirs take a resolved number. Must be in (0,1]; unset,
 * blank, or out of range → the 0.5 default.
 */
export function adaptiveL3EscalateThreshold(): number {
  const raw = process.env.FOVEA_ADAPTIVE_L3_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ADAPTIVE_L3_THRESHOLD;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_ADAPTIVE_L3_THRESHOLD;
}
