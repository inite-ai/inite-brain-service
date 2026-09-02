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

/**
 * The three kind registries are Maps, NOT record literals, on purpose:
 * `kind` is caller-controlled (POST /v1/ingest/evidence-asset), and on a
 * record literal a prototype-chain name ('constructor', '__proto__',
 * 'toString'…) resolves to an INHERITED member — it passes a truthiness
 * guard and then crashes the unknown-field walk with a TypeError (500
 * where a 400 belongs; CodeQL js/unvalidated-dynamic-method-call).
 * Map.get never walks a prototype chain, so every non-registered name is
 * simply an unknown kind.
 */

/** Locator kind → modalities it may target (the cross-check matrix). */
const KIND_MODALITIES = new Map<string, readonly string[]>([
  ['charRange', ['document']],
  ['pageRegion', ['document', 'image']],
  ['timeRange', ['audio', 'video', 'sensor']],
  ['frameRange', ['video']],
  ['track', ['audio', 'video', 'sensor']],
]);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An int pair forming a strictly-increasing non-negative range. */
function rangeError(lo: unknown, hi: unknown, msg: string): string | null {
  if (!isInt(lo) || !isInt(hi) || lo < 0 || hi <= lo) return msg;
  return null;
}

/** Per-kind shape validators; each returns an error string or null. */
const SHAPE_VALIDATORS = new Map<string, (loc: Record<string, unknown>) => string | null>([
  [
    'charRange',
    (loc) => rangeError(loc.start, loc.end, 'charRange needs int start >= 0 and end > start'),
  ],
  [
    'pageRegion',
    (loc) => {
      if (!isInt(loc.page) || loc.page < 0) return 'pageRegion needs int page >= 0';
      for (const k of ['x', 'y', 'w', 'h']) {
        const v = loc[k];
        if (!isNum(v) || v < 0 || v > 1) return `pageRegion needs ${k} in [0,1]`;
      }
      if ((loc.w as number) === 0 || (loc.h as number) === 0) {
        return 'pageRegion needs positive w and h';
      }
      if ((loc.x as number) + (loc.w as number) > 1) return 'pageRegion x + w must be <= 1';
      if ((loc.y as number) + (loc.h as number) > 1) return 'pageRegion y + h must be <= 1';
      return null;
    },
  ],
  [
    'timeRange',
    (loc) =>
      rangeError(loc.startMs, loc.endMs, 'timeRange needs int startMs >= 0 and endMs > startMs'),
  ],
  [
    'frameRange',
    (loc) =>
      rangeError(
        loc.startFrame,
        loc.endFrame,
        'frameRange needs int startFrame >= 0 and endFrame > startFrame',
      ),
  ],
  [
    'track',
    (loc) => {
      if (typeof loc.trackId !== 'string' || loc.trackId.length === 0 || loc.trackId.length > 256) {
        return 'track needs a non-empty trackId (<=256 chars)';
      }
      for (const k of ['startMs', 'endMs']) {
        const v = loc[k];
        if (v !== undefined && (!isInt(v) || v < 0)) return `track ${k} must be a non-negative int`;
      }
      if (
        isInt(loc.startMs) &&
        isInt(loc.endMs) &&
        (loc.endMs as number) <= (loc.startMs as number)
      ) {
        return 'track endMs must be greater than startMs';
      }
      return null;
    },
  ],
]);

const LOCATOR_FIELDS = new Map<string, ReadonlySet<string>>([
  ['charRange', new Set(['kind', 'start', 'end'])],
  ['pageRegion', new Set(['kind', 'page', 'x', 'y', 'w', 'h'])],
  ['timeRange', new Set(['kind', 'startMs', 'endMs'])],
  ['frameRange', new Set(['kind', 'startFrame', 'endFrame'])],
  ['track', new Set(['kind', 'trackId', 'startMs', 'endMs'])],
]);

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
  // Map.get: no prototype chain, so 'constructor'/'__proto__'/'toString'
  // read as unknown kinds (see the registry doc comment above).
  const allowed = KIND_MODALITIES.get(kind);
  const validate = SHAPE_VALIDATORS.get(kind);
  const fields = LOCATOR_FIELDS.get(kind);
  if (!allowed || !validate || !fields) return `unknown locator kind '${String(loc.kind)}'`;
  const unknownField = Object.keys(loc).find((field) => !fields.has(field));
  if (unknownField) return `locator kind '${kind}' has unknown field '${unknownField}'`;
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
