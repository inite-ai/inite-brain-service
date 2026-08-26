/**
 * FragmentLocator — the kind-discriminated "where in the asset" shape of
 * evidence_fragment.locator (0109). Pure module: the DB column is
 * FLEXIBLE, so THIS is the schema — validateLocator() runs at the write
 * seam (evidence-store.service.ts) and cross-checks the locator kind
 * against the parent asset's modality.
 */

export type FragmentLocator =
  /** Character span in a text-bearing document (code points). */
  | { kind: 'charRange'; start: number; end: number }
  /** Page + normalized bounding box (0..1 coords); page 0 for an image. */
  | { kind: 'pageRegion'; page: number; x: number; y: number; w: number; h: number }
  /** Time span in a temporal medium. */
  | { kind: 'timeRange'; startMs: number; endMs: number }
  /** Frame span in a video. */
  | { kind: 'frameRange'; startFrame: number; endFrame: number }
  /** A tracked object/channel, optionally time-bounded. */
  | { kind: 'track'; trackId: string; startMs?: number; endMs?: number };

/** Locator kind → modalities it may target (the cross-check matrix). */
const KIND_MODALITIES: Record<string, readonly string[]> = {
  charRange: ['document'],
  pageRegion: ['document', 'image'],
  timeRange: ['audio', 'video', 'sensor'],
  frameRange: ['video'],
  track: ['audio', 'video', 'sensor'],
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An int pair forming a strictly-increasing non-negative range. */
function rangeError(lo: unknown, hi: unknown, msg: string): string | null {
  if (!isInt(lo) || !isInt(hi) || lo < 0 || hi <= lo) return msg;
  return null;
}

/** Per-kind shape validators; each returns an error string or null. */
const SHAPE_VALIDATORS: Record<string, (loc: Record<string, unknown>) => string | null> = {
  charRange: (loc) =>
    rangeError(loc.start, loc.end, 'charRange needs int start >= 0 and end > start'),
  pageRegion: (loc) => {
    if (!isInt(loc.page) || loc.page < 0) return 'pageRegion needs int page >= 0';
    for (const k of ['x', 'y', 'w', 'h']) {
      const v = loc[k];
      if (!isNum(v) || v < 0 || v > 1) return `pageRegion needs ${k} in [0,1]`;
    }
    return null;
  },
  timeRange: (loc) =>
    rangeError(loc.startMs, loc.endMs, 'timeRange needs int startMs >= 0 and endMs > startMs'),
  frameRange: (loc) =>
    rangeError(
      loc.startFrame,
      loc.endFrame,
      'frameRange needs int startFrame >= 0 and endFrame > startFrame',
    ),
  track: (loc) => {
    if (typeof loc.trackId !== 'string' || loc.trackId.length === 0 || loc.trackId.length > 256) {
      return 'track needs a non-empty trackId (<=256 chars)';
    }
    for (const k of ['startMs', 'endMs']) {
      const v = loc[k];
      if (v !== undefined && (!isInt(v) || v < 0)) return `track ${k} must be a non-negative int`;
    }
    return null;
  },
};

/**
 * Validate a locator against the parent asset's modality. Returns a
 * human-readable error string, or null when valid (the
 * evidenceValidationError idiom — no exceptions from a pure checker).
 * Matrix: charRange→document; pageRegion→document|image (image ⇒ page
 * 0); timeRange/track→audio|video|sensor; frameRange→video. An unknown
 * kind is ALWAYS an error — never stored opaquely.
 */
export function validateLocator(modality: string, locator: unknown): string | null {
  if (locator === null || typeof locator !== 'object' || Array.isArray(locator)) {
    return 'locator must be an object';
  }
  const loc = locator as Record<string, unknown>;
  const kind = typeof loc.kind === 'string' ? loc.kind : '';
  const allowed = KIND_MODALITIES[kind];
  const validate = SHAPE_VALIDATORS[kind];
  if (!allowed || !validate) return `unknown locator kind '${String(loc.kind)}'`;
  if (!allowed.includes(modality)) {
    return `locator kind '${kind}' does not apply to modality '${modality}'`;
  }
  const err = validate(loc);
  if (err) return err;
  // An image has exactly one "page" — locating page 3 of a JPEG is a
  // caller bug the FLEXIBLE column would otherwise store silently.
  if (kind === 'pageRegion' && modality === 'image' && loc.page !== 0) {
    return 'pageRegion on an image must use page 0';
  }
  return null;
}
