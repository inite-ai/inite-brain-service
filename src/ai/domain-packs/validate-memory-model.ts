import { DomainPackError } from './validate';
import {
  MM_MAX_ATTENTION_HINTS,
  MM_MAX_CUES,
  MM_MAX_RETENTION_HINTS,
  MM_MAX_MODALITY_PROCESSORS,
  MM_MAX_SCENE_SCHEMAS,
  MM_MAX_STATES,
  MM_MAX_STATE_MODELS,
  MM_MAX_TRANSITIONS,
  MM_MAX_VERIFICATION_RULES,
  PACK_MEMORY_MODALITIES,
  PACK_REPRESENTATION_KINDS,
  PACK_NAMESPACE_SEP,
  type DomainPackManifest,
  type PackAttentionHint,
  type PackRetentionHint,
  type PackModalityProcessor,
  type PackSceneSchema,
  type PackStateModel,
  type PackVerificationRule,
} from './manifest';

/**
 * Validation for the memoryModel manifest section (PackMemoryModel in
 * manifest.ts — the domain perception contract). Structural + referential
 * only, and deliberately env-free like the rest of `pnpm pack:validate`.
 *
 * Two laws are enforced here, not merely documented:
 *  - ANTI-DSL: every free-text field is plain literal text. Length-capped,
 *    no control characters, and no template/DSL syntax (`{{`, `${`, `<%`,
 *    backticks, `|`, `\`). claimPattern additionally rejects the regex
 *    metacharacters []()*+?^$ — it is a literal substring, not a pattern.
 *  - REFERENTIAL FENCE: hints may only reference the pack's OWN namespaces
 *    (its predicate localIds, its sceneSchema ids, and the fixed zoom
 *    literals). A pack can never point attention or retention at core or
 *    another pack's vocabulary.
 *
 * Exported: the memory-model reader re-runs it defensively against stored
 * manifests before serving anything (PackToolsReaderService mold).
 */

const SNAKE = /^[a-z][a-z0-9_]*$/;
/** Fixed zoom targets available to every pack alongside its own scenes. */
const ZOOM_LITERALS = new Set(['episodes', 'facts', 'scenes']);
const REQUIRES = new Set(['human_confirmation', 'corroboration', 'recency_check']);
const RETENTION_HINTS = new Set(['ephemeral', 'standard', 'durable']);
const MEMORY_MODEL_FIELDS = new Set([
  'sceneSchemas',
  'stateModels',
  'attentionHints',
  'verificationRules',
  'retentionHints',
  'modalities',
  'processors',
  'rawEvidence',
]);
const MODALITIES = new Set<string>(PACK_MEMORY_MODALITIES);
const REPRESENTATION_KINDS = new Set<string>(PACK_REPRESENTATION_KINDS);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DSL_MARKERS = ['{{', '${', '<%', '`', '|', '\\'];
const REGEX_METACHARS = /[[\]()*+?^$]/;

/** Anti-DSL guard for one free-text field: plain literal text only. */
function assertLiteralText(opts: {
  packId: string;
  field: string;
  value: unknown;
  min: number;
  max: number;
}): void {
  const { packId, field, value, min, max } = opts;
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel ${field} must be a string of ${min}..${max} characters`,
    );
  }
  if (CONTROL_CHARS.test(value)) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel ${field} must not contain control characters`,
    );
  }
  for (const marker of DSL_MARKERS) {
    if (value.includes(marker)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel ${field} must be plain literal text — "${marker}" is not allowed (no templates, code, or patterns)`,
      );
    }
  }
}

function assertSnakeId(packId: string, field: string, value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !SNAKE.test(value) ||
    value.includes(PACK_NAMESPACE_SEP) ||
    value.length > 64
  ) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel ${field} "${String(value)}" must be snake_case of at most 64 chars and must not contain "${PACK_NAMESPACE_SEP}"`,
    );
  }
}

function assertObjectEntry(packId: string, field: string, value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainPackError(`pack "${packId}" memoryModel ${field} entries must be objects`);
  }
}

function assertKnownKeys(opts: {
  packId: string;
  field: string;
  value: Record<string, unknown>;
  allowed: ReadonlySet<string>;
}): void {
  const { packId, field, value, allowed } = opts;
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel ${field} contains unknown field "${unknown}"`,
    );
  }
}

/** A present list must be a non-empty array within its cap (mcpTools mold:
 *  "declare it or omit it" — present-but-empty is an authoring error). */
function assertPresentList(opts: {
  packId: string;
  field: string;
  value: unknown;
  cap: number;
}): asserts opts is { packId: string; field: string; value: unknown[]; cap: number } {
  const { packId, field, value, cap } = opts;
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel ${field} must be a non-empty array (omit the field instead of declaring it empty)`,
    );
  }
  if (value.length > cap) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel declares ${value.length} ${field} — max is ${cap}`,
    );
  }
}

interface MemoryModelShape {
  sceneSchemas?: unknown;
  stateModels?: unknown;
  attentionHints?: unknown;
  verificationRules?: unknown;
  retentionHints?: unknown;
  /** Modality-era keys (0112 consent tier). Substantive sections in their
   *  own right — a modality-only memoryModel is a valid manifest — and now
   *  structurally validated below (validateModalities / validateProcessors /
   *  validateRawEvidence). */
  modalities?: unknown;
  processors?: unknown;
  rawEvidence?: unknown;
}

/**
 * Validate a pack's memoryModel section. Referential fences run against
 * the pack's OWN predicate localIds and the section's own sceneSchema
 * ids — dispatched from validatePack's optional-section block and re-run
 * defensively by the memory-model reader on stored manifests.
 */
export function validateMemoryModel(pack: DomainPackManifest, mm: unknown): void {
  if (typeof mm !== 'object' || mm === null || Array.isArray(mm)) {
    throw new DomainPackError(`pack "${pack.id}" memoryModel must be an object`);
  }
  const model = mm as MemoryModelShape;
  assertKnownKeys({
    packId: pack.id,
    field: 'section',
    value: mm as Record<string, unknown>,
    allowed: MEMORY_MODEL_FIELDS,
  });
  const declared = [
    model.sceneSchemas,
    model.stateModels,
    model.attentionHints,
    model.verificationRules,
    model.retentionHints,
    model.modalities,
    model.processors,
    model.rawEvidence,
  ].filter((v) => v !== undefined);
  if (declared.length === 0) {
    throw new DomainPackError(
      `pack "${pack.id}" memoryModel must declare at least one of sceneSchemas|stateModels|attentionHints|verificationRules|retentionHints|modalities|processors|rawEvidence (omit the section instead of declaring it empty)`,
    );
  }
  const sceneIds = validateSceneSchemas(pack.id, model.sceneSchemas);
  validateStateModels(pack.id, model.stateModels, sceneIds);
  const predicateLocalIds = new Set(pack.predicates.map((p) => p.localId));
  validateAttentionHints({
    packId: pack.id,
    hints: model.attentionHints,
    predicateLocalIds,
    sceneIds,
  });
  validateVerificationRules(pack.id, model.verificationRules);
  validateRetentionHints({
    packId: pack.id,
    hints: model.retentionHints,
    predicateLocalIds,
    sceneIds,
  });
  validateModalities(pack.id, model.modalities);
  validateProcessors(pack.id, model.processors);
  validateRawEvidence(pack.id, model.rawEvidence);
}

function validateModalities(packId: string, modalities: unknown): void {
  if (modalities === undefined) return;
  assertPresentList({
    packId,
    field: 'modalities',
    value: modalities,
    cap: PACK_MEMORY_MODALITIES.length,
  });
  const seen = new Set<string>();
  for (const modality of modalities as unknown[]) {
    if (typeof modality !== 'string' || !MODALITIES.has(modality)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel modality "${String(modality)}" must be one of ${PACK_MEMORY_MODALITIES.join('|')}`,
      );
    }
    if (seen.has(modality)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel declares duplicate modality "${modality}"`,
      );
    }
    seen.add(modality);
  }
}

function validateProcessors(packId: string, processors: unknown): void {
  if (processors === undefined) return;
  assertPresentList({
    packId,
    field: 'processors',
    value: processors,
    cap: MM_MAX_MODALITY_PROCESSORS,
  });
  const ids = new Set<string>();
  for (const entry of processors as unknown[]) {
    assertObjectEntry(packId, 'processors', entry);
    assertKnownKeys({
      packId,
      field: 'processor',
      value: entry as Record<string, unknown>,
      allowed: new Set(['id', 'modality', 'produces']),
    });
    const processor = entry as Partial<PackModalityProcessor>;
    assertSnakeId(packId, 'processor id', processor.id);
    if (ids.has(processor.id)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel declares duplicate processor id "${processor.id}"`,
      );
    }
    ids.add(processor.id);
    if (typeof processor.modality !== 'string' || !MODALITIES.has(processor.modality)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel processor "${processor.id}" modality must be one of ${PACK_MEMORY_MODALITIES.join('|')}`,
      );
    }
    if (
      !Array.isArray(processor.produces) ||
      processor.produces.length === 0 ||
      processor.produces.length > PACK_REPRESENTATION_KINDS.length
    ) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel processor "${processor.id}" produces must be 1..${PACK_REPRESENTATION_KINDS.length} representation kinds`,
      );
    }
    const produced = new Set<string>();
    for (const kind of processor.produces) {
      if (typeof kind !== 'string' || !REPRESENTATION_KINDS.has(kind)) {
        throw new DomainPackError(
          `pack "${packId}" memoryModel processor "${processor.id}" representation "${String(kind)}" must be one of ${PACK_REPRESENTATION_KINDS.join('|')}`,
        );
      }
      if (produced.has(kind)) {
        throw new DomainPackError(
          `pack "${packId}" memoryModel processor "${processor.id}" declares duplicate representation "${kind}"`,
        );
      }
      produced.add(kind);
    }
  }
}

function validateRawEvidence(packId: string, rawEvidence: unknown): void {
  if (rawEvidence === undefined) return;
  assertObjectEntry(packId, 'rawEvidence', rawEvidence);
  const raw = rawEvidence as Record<string, unknown>;
  assertKnownKeys({ packId, field: 'rawEvidence', value: raw, allowed: new Set(['serve']) });
  if (raw.serve !== true) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel rawEvidence.serve must be literal true (omit rawEvidence to deny serving)`,
    );
  }
}

/** Returns the declared sceneSchema ids (the zoom/retention namespace). */
function validateSceneSchemas(packId: string, schemas: unknown): Set<string> {
  const sceneIds = new Set<string>();
  if (schemas === undefined) return sceneIds;
  assertPresentList({ packId, field: 'sceneSchemas', value: schemas, cap: MM_MAX_SCENE_SCHEMAS });
  for (const entry of schemas as unknown[]) {
    assertObjectEntry(packId, 'sceneSchemas', entry);
    const s = entry as Partial<PackSceneSchema>;
    assertSnakeId(packId, 'sceneSchema id', s.id);
    if (sceneIds.has(s.id)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel declares duplicate sceneSchema id "${s.id}"`,
      );
    }
    sceneIds.add(s.id);
    assertLiteralText({
      packId,
      field: `sceneSchema "${s.id}" description`,
      value: s.description,
      min: 1,
      max: 500,
    });
    if (s.cues === undefined) continue;
    if (!Array.isArray(s.cues) || s.cues.length === 0 || s.cues.length > MM_MAX_CUES) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel sceneSchema "${s.id}" cues must be 1..${MM_MAX_CUES} strings`,
      );
    }
    for (const cue of s.cues) {
      assertLiteralText({
        packId,
        field: `sceneSchema "${s.id}" cue`,
        value: cue,
        min: 2,
        max: 64,
      });
    }
  }
  return sceneIds;
}

function validateStateModels(packId: string, models: unknown, sceneIds: Set<string>): void {
  if (models === undefined) return;
  assertPresentList({ packId, field: 'stateModels', value: models, cap: MM_MAX_STATE_MODELS });
  const ids = new Set<string>();
  for (const entry of models as unknown[]) {
    assertObjectEntry(packId, 'stateModels', entry);
    const m = entry as Partial<PackStateModel>;
    assertSnakeId(packId, 'stateModel id', m.id);
    if (ids.has(m.id)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel declares duplicate stateModel id "${m.id}"`,
      );
    }
    // sceneSchema ids and stateModel ids share downstream reference space
    // (retentionHints, zoom) — a cross-list collision would make a
    // reference ambiguous, so reject it outright.
    if (sceneIds.has(m.id)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel stateModel id "${m.id}" collides with a sceneSchema id`,
      );
    }
    ids.add(m.id);
    assertLiteralText({
      packId,
      field: `stateModel "${m.id}" subjectType`,
      value: m.subjectType,
      min: 1,
      max: 64,
    });
    validateStates(packId, m);
  }
}

/** states (2..16 snake_case unique) + transitions (≤64, both ends ∈ states). */
function validateStates(packId: string, m: Partial<PackStateModel>): void {
  const id = String(m.id);
  if (!Array.isArray(m.states) || m.states.length < 2 || m.states.length > MM_MAX_STATES) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel stateModel "${id}" states must be 2..${MM_MAX_STATES} entries`,
    );
  }
  const states = new Set<string>();
  for (const state of m.states) {
    assertSnakeId(packId, `stateModel "${id}" state`, state);
    if (states.has(state)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel stateModel "${id}" declares duplicate state "${state}"`,
      );
    }
    states.add(state);
  }
  if (m.transitions === undefined) return;
  if (!Array.isArray(m.transitions) || m.transitions.length === 0) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel stateModel "${id}" transitions must be a non-empty array (omit the field instead)`,
    );
  }
  if (m.transitions.length > MM_MAX_TRANSITIONS) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel stateModel "${id}" declares ${m.transitions.length} transitions — max is ${MM_MAX_TRANSITIONS}`,
    );
  }
  for (const t of m.transitions) {
    assertObjectEntry(packId, `stateModel "${id}" transitions`, t);
    for (const end of ['from', 'to'] as const) {
      const v = (t as unknown as Record<string, unknown>)[end];
      if (typeof v !== 'string' || !states.has(v)) {
        throw new DomainPackError(
          `pack "${packId}" memoryModel stateModel "${id}" transition ${end} "${String(v)}" is not a declared state`,
        );
      }
    }
  }
}

function validateAttentionHints(opts: {
  packId: string;
  hints: unknown;
  predicateLocalIds: Set<string>;
  sceneIds: Set<string>;
}): void {
  const { packId, hints, predicateLocalIds, sceneIds } = opts;
  if (hints === undefined) return;
  assertPresentList({ packId, field: 'attentionHints', value: hints, cap: MM_MAX_ATTENTION_HINTS });
  const cues = new Set<string>();
  for (const entry of hints as unknown[]) {
    assertObjectEntry(packId, 'attentionHints', entry);
    const h = entry as Partial<PackAttentionHint>;
    assertLiteralText({ packId, field: 'attentionHint cue', value: h.cue, min: 2, max: 64 });
    const cue = h.cue as string;
    if (cues.has(cue)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel declares duplicate attentionHint cue "${cue}"`,
      );
    }
    cues.add(cue);
    validateHintRefs({ packId, cue, hint: h, predicateLocalIds, sceneIds });
    if (
      h.weight !== undefined &&
      (typeof h.weight !== 'number' || !(h.weight > 0) || h.weight > 1)
    ) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel attentionHint "${cue}" weight must be a number in (0, 1]`,
      );
    }
  }
}

/** prefer ⊆ own predicate localIds; zoom ⊆ own sceneSchema ids ∪ literals. */
function validateHintRefs(opts: {
  packId: string;
  cue: string;
  hint: Partial<PackAttentionHint>;
  predicateLocalIds: Set<string>;
  sceneIds: Set<string>;
}): void {
  const { packId, cue, hint, predicateLocalIds, sceneIds } = opts;
  if (hint.prefer !== undefined) {
    if (!Array.isArray(hint.prefer) || hint.prefer.length === 0 || hint.prefer.length > 8) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel attentionHint "${cue}" prefer must be 1..8 predicate localIds`,
      );
    }
    for (const p of hint.prefer) {
      if (typeof p !== 'string' || !predicateLocalIds.has(p)) {
        throw new DomainPackError(
          `pack "${packId}" memoryModel attentionHint "${cue}" prefer references "${String(p)}", which is not a predicate of this pack`,
        );
      }
    }
  }
  if (hint.zoom === undefined) return;
  if (!Array.isArray(hint.zoom) || hint.zoom.length === 0 || hint.zoom.length > 4) {
    throw new DomainPackError(
      `pack "${packId}" memoryModel attentionHint "${cue}" zoom must be 1..4 targets`,
    );
  }
  for (const z of hint.zoom) {
    if (typeof z !== 'string' || (!ZOOM_LITERALS.has(z) && !sceneIds.has(z))) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel attentionHint "${cue}" zoom target "${String(z)}" must be one of this pack's sceneSchema ids or ${[...ZOOM_LITERALS].join('|')}`,
      );
    }
  }
}

function validateVerificationRules(packId: string, rules: unknown): void {
  if (rules === undefined) return;
  assertPresentList({
    packId,
    field: 'verificationRules',
    value: rules,
    cap: MM_MAX_VERIFICATION_RULES,
  });
  for (const entry of rules as unknown[]) {
    assertObjectEntry(packId, 'verificationRules', entry);
    const r = entry as Partial<PackVerificationRule>;
    if (!REQUIRES.has(r.requires as string)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel verificationRule requires "${String(r.requires)}" must be one of ${[...REQUIRES].join('|')}`,
      );
    }
    if (r.claimPattern === undefined) continue;
    assertLiteralText({
      packId,
      field: 'verificationRule claimPattern',
      value: r.claimPattern,
      min: 2,
      max: 128,
    });
    if (REGEX_METACHARS.test(r.claimPattern)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel verificationRule claimPattern "${r.claimPattern}" must be a literal substring, not a pattern — regex metacharacters are not allowed`,
      );
    }
  }
}

function validateRetentionHints(opts: {
  packId: string;
  hints: unknown;
  predicateLocalIds: Set<string>;
  sceneIds: Set<string>;
}): void {
  const { packId, hints, predicateLocalIds, sceneIds } = opts;
  if (hints === undefined) return;
  assertPresentList({ packId, field: 'retentionHints', value: hints, cap: MM_MAX_RETENTION_HINTS });
  const seen = new Set<string>();
  for (const entry of hints as unknown[]) {
    assertObjectEntry(packId, 'retentionHints', entry);
    const h = entry as Partial<PackRetentionHint>;
    const ref = h.predicateOrScene;
    if (typeof ref !== 'string' || (!predicateLocalIds.has(ref) && !sceneIds.has(ref))) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel retentionHint references "${String(ref)}", which is neither a predicate localId nor a sceneSchema id of this pack`,
      );
    }
    if (seen.has(ref)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel declares duplicate retentionHint for "${ref}"`,
      );
    }
    seen.add(ref);
    if (!RETENTION_HINTS.has(h.hint as string)) {
      throw new DomainPackError(
        `pack "${packId}" memoryModel retentionHint "${ref}" hint "${String(h.hint)}" must be one of ${[...RETENTION_HINTS].join('|')}`,
      );
    }
  }
}
