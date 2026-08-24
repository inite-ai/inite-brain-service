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
