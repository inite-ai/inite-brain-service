import { traceArtifact } from '../../common/debug-trace';
import type {
  ChatRoute,
  EditOp,
  RawRouteOutput,
  RawSpan,
  Span,
  TemporalAnchor,
  ValidationReport,
} from './types';

/** NFC normalization — keeps the multi-byte cases (Cyrillic combining
 *  marks, EN-vs-RU quotes) from breaking offset arithmetic. */
export function nfc(s: string): string {
  return s.normalize('NFC');
}

/**
 * Validate a span against the input. Three levels:
 *   1. Exact: original.slice(start,end) === text
 *   2. NFC-equivalent: nfc(original).slice(start,end) === nfc(text)
 *   3. Repair: find the first occurrence of nfc(text) in nfc(original),
 *      synthesize offsets. Logs but accepts.
 *
 * Returns the validated Span with possibly-repaired offsets, or null if
 * no level matched.
 */
export function validateSpan(
  original: string,
  normalizedOriginal: string,
  raw: RawSpan | undefined | null,
): Span | null {
  if (!raw || typeof raw.text !== 'string') return null;
  if (raw.text.trim().length === 0) return null;
  const { text, start, end } = raw;
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= original.length &&
    start < end &&
    original.slice(start, end) === text
  ) {
    return { text, start, end };
  }
  const normalizedText = nfc(text);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= normalizedOriginal.length &&
    start < end &&
    normalizedOriginal.slice(start, end) === normalizedText
  ) {
    return { text, start, end };
  }
  const idx = normalizedOriginal.indexOf(normalizedText);
  if (idx >= 0) {
    return { text, start: idx, end: idx + normalizedText.length };
  }
  return null;
}

/**
 * Apply edits[] right-to-left so earlier offsets remain valid as we
 * splice. filterOp selects which edits to apply — used to derive
 * cleanedQuery by skipping canonicalize_mention edits.
 */
export function applyEdits(
  original: string,
  edits: EditOp[],
  filterOp: (op: EditOp['op']) => boolean,
): string {
  const applicable = edits
    .filter((e) => filterOp(e.op))
    .sort((a, b) => b.sourceSpan.start - a.sourceSpan.start);
  let working = original;
  for (const e of applicable) {
    const { start, end } = e.sourceSpan;
    const replacement =
      e.op === 'canonicalize_mention'
        ? e.canonical
        : e.op === 'collapse_state_change'
          ? e.replacement
          : ''; // strip_temporal
    working = working.slice(0, start) + replacement + working.slice(end);
  }
  // Collapse any double-spaces strip_temporal left behind.
  return working.replace(/\s+/g, ' ').trim();
}

export function isValidIso(s: string): boolean {
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

/**
 * Extracts the first balanced top-level JSON object from a possibly
 * noisy LLM output. Handles leading sentinel tokens, markdown code
 * fences, trailing prose.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const inner = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const start = inner.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in router response');
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < inner.length; i++) {
    const c = inner[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return inner.slice(start, i + 1);
    }
  }
  throw new Error('unterminated JSON object in router response');
}

/**
 * Validate the raw LLM output and assemble a ChatRoute. Each slot
 * degrades independently — a failed asOf becomes absent, a failed
 * mention is dropped, a failed edit is skipped. The route ALWAYS
 * returns SOMETHING; downstream never 500s on a partial validation
 * failure.
 *
 * Six passes:
 *   1. Mentions — every nameSpan must ground; canonical ∈ knownNames.
 *   2. Predicate hints — triggerSpan grounds + predicateId ∈ vocab.
 *   3. Temporal anchors — grounded span + valid ISO; cross-field rule:
 *      tell ⇒ validFrom only; ask ⇒ asOf only.
 *   4. Edits — synth canonicalize_mention from accepted mentions;
 *      validate collapse_state_change; drop overlaps right-to-left.
 *   5. Auto-derive strip_temporal from grounded anchors.
 *   6. Apply edits → normalizedMessage + cleanedQuery (ask only).
 */
export function validateAndAssemble(
  message: string,
  parsed: RawRouteOutput,
  vocab: Set<string>,
  knownNames: Set<string>,
): ChatRoute {
  const normalizedInput = nfc(message);
  const report: ValidationReport = {
    acceptedEdits: 0,
    droppedEdits: [],
    acceptedMentions: 0,
    droppedMentions: [],
    acceptedHints: 0,
    droppedHints: [],
    asOfStatus: 'absent',
    validFromStatus: 'absent',
  };

  const mentions = collectMentions(
    parsed,
    message,
    normalizedInput,
    knownNames,
    report,
  );
  const predicateHints = collectPredicateHints(
    parsed,
    message,
    normalizedInput,
    vocab,
    report,
  );
  const { asOf, validFrom } = collectTemporalAnchors(
    parsed,
    message,
    normalizedInput,
    report,
  );
  const acceptedEdits = collectEdits(
    parsed,
    message,
    normalizedInput,
    mentions,
    report,
  );
  const autoStripEdits = deriveStripTemporalEdits(
    acceptedEdits.map((c) => c.span),
    asOf,
    validFrom,
  );
  const allEdits = [...acceptedEdits.map((c) => c.edit), ...autoStripEdits];

  const normalizedMessage = applyEdits(message, allEdits, () => true);
  const cleanedQuery =
    parsed.intent === 'ask'
      ? applyEdits(message, allEdits, (op) => op !== 'canonicalize_mention')
      : undefined;

  traceArtifact('demo.chat.validation', report);

  return {
    intent: parsed.intent,
    normalizedMessage,
    ...(cleanedQuery !== undefined && cleanedQuery !== message
      ? { cleanedQuery }
      : {}),
    mentions,
    predicateHints,
    ...(asOf ? { asOf } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  };
}

function collectMentions(
  parsed: RawRouteOutput,
  message: string,
  normalizedInput: string,
  knownNames: Set<string>,
  report: ValidationReport,
): Array<{ canonical: string; span: Span }> {
  const mentions: Array<{ canonical: string; span: Span }> = [];
  for (const m of parsed.mentions ?? []) {
    const span = validateSpan(message, normalizedInput, m.nameSpan);
    if (!span) {
      report.droppedMentions.push({
        canonical: m.canonical ?? undefined,
        reason: 'ungrounded',
        span: m.nameSpan,
      });
      continue;
    }
    if (!m.canonical || !knownNames.has(m.canonical)) {
      report.droppedMentions.push({
        canonical: m.canonical ?? undefined,
        reason: 'not_in_known_names',
        span,
      });
      continue;
    }
    mentions.push({ canonical: m.canonical, span });
    report.acceptedMentions++;
  }
  return mentions;
}

function collectPredicateHints(
  parsed: RawRouteOutput,
  message: string,
  normalizedInput: string,
  vocab: Set<string>,
  report: ValidationReport,
): Array<{ predicateId: string; triggerSpan: Span }> {
  const out: Array<{ predicateId: string; triggerSpan: Span }> = [];
  if (parsed.intent !== 'ask') return out;
  for (const h of parsed.predicateHints ?? []) {
    const span = validateSpan(message, normalizedInput, h.triggerSpan);
    if (!span) {
      report.droppedHints.push({
        predicateId: h.predicateId,
        reason: 'ungrounded',
        span: h.triggerSpan,
      });
      continue;
    }
    if (vocab.size > 0 && !vocab.has(h.predicateId)) {
      report.droppedHints.push({
        predicateId: h.predicateId,
        reason: 'not_in_vocab',
        span,
      });
      continue;
    }
    out.push({ predicateId: h.predicateId, triggerSpan: span });
    report.acceptedHints++;
  }
  return out;
}

function collectTemporalAnchors(
  parsed: RawRouteOutput,
  message: string,
  normalizedInput: string,
  report: ValidationReport,
): { asOf?: TemporalAnchor; validFrom?: TemporalAnchor } {
  let asOf: TemporalAnchor | undefined;
  if (parsed.intent === 'ask' && parsed.asOf) {
    const span = validateSpan(message, normalizedInput, parsed.asOf.anchorSpan);
    if (span && isValidIso(parsed.asOf.iso)) {
      asOf = { iso: parsed.asOf.iso, anchorSpan: span };
      report.asOfStatus = 'grounded';
    } else {
      report.asOfStatus = 'ungrounded';
    }
  }
  let validFrom: TemporalAnchor | undefined;
  if (parsed.intent === 'tell' && parsed.validFrom) {
    const span = validateSpan(
      message,
      normalizedInput,
      parsed.validFrom.anchorSpan,
    );
    if (span && isValidIso(parsed.validFrom.iso)) {
      validFrom = { iso: parsed.validFrom.iso, anchorSpan: span };
      report.validFromStatus = 'grounded';
    } else {
      report.validFromStatus = 'ungrounded';
    }
  }
  return { asOf, validFrom };
}

function collectEdits(
  parsed: RawRouteOutput,
  message: string,
  normalizedInput: string,
  mentions: Array<{ canonical: string; span: Span }>,
  report: ValidationReport,
): Array<{ edit: EditOp; span: Span }> {
  // Synthesise canonicalize_mention 1:1 from accepted mentions, then
  // validate LLM-emitted collapse_state_change edits. Edits whose
  // sourceSpan overlaps another accepted edit are dropped right-to-left
  // so splicing remains coherent.
  const candidates: Array<{ edit: EditOp; span: Span }> = mentions.map((m) => ({
    edit: {
      op: 'canonicalize_mention' as const,
      sourceSpan: m.span,
      canonical: m.canonical,
    },
    span: m.span,
  }));
  for (const e of parsed.edits ?? []) {
    const span = validateSpan(message, normalizedInput, e.sourceSpan);
    if (!span) {
      report.droppedEdits.push({
        op: e.op,
        reason: 'ungrounded',
        span: e.sourceSpan,
      });
      continue;
    }
    if (e.op !== 'collapse_state_change') {
      report.droppedEdits.push({ op: e.op, reason: 'llm_emit_disabled', span });
      continue;
    }
    candidates.push({
      edit: {
        op: 'collapse_state_change',
        sourceSpan: span,
        replacement: e.replacement ?? '',
      },
      span,
    });
  }
  candidates.sort((a, b) => a.span.start - b.span.start);
  const accepted: Array<{ edit: EditOp; span: Span }> = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.span.start < lastEnd) {
      report.droppedEdits.push({
        op: c.edit.op,
        reason: 'overlaps_prior_edit',
        span: c.span,
      });
      continue;
    }
    accepted.push(c);
    lastEnd = c.span.end;
  }
  report.acceptedEdits = accepted.length;
  return accepted;
}

function deriveStripTemporalEdits(
  acceptedSpans: Span[],
  asOf: TemporalAnchor | undefined,
  validFrom: TemporalAnchor | undefined,
): EditOp[] {
  // Auto-derive strip_temporal from grounded asOf/validFrom anchors.
  // The LLM is supposed to emit these explicitly but is inconsistent —
  // and the rule is mechanical: if we captured the timestamp from a
  // span, strip that span from the downstream message. Skip when the
  // anchor overlaps a prior accepted edit.
  const out: EditOp[] = [];
  for (const anchor of [asOf?.anchorSpan, validFrom?.anchorSpan]) {
    if (!anchor) continue;
    const overlaps = acceptedSpans.some(
      (s) => !(s.end <= anchor.start || s.start >= anchor.end),
    );
    if (overlaps) continue;
    out.push({ op: 'strip_temporal', sourceSpan: anchor });
  }
  return out;
}
