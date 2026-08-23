import type OpenAI from 'openai';
import { chatCallParams } from '../ai/openai-client';
import { resolveExtractionProfile } from '../ai/extraction-profile';

/**
 * Deriver client — the session-extraction LLM calls, split out of
 * window-deriver.service.ts (V10.5 audit pass, the god-file pattern:
 * same seam as generator-client/verifier on the synthesize side). The
 * service decides WHAT to derive; this module owns the prompts and HOW
 * the calls are made — pass/retry mechanics, the completion-pass
 * union, the volume-neutral salience grading turn.
 */

export const DERIVER_SYSTEM = `You extract durable MEMORY PROPOSITIONS from ONE session of a two-person dialogue. The original conversation will NOT be available at retrieval time — each proposition must stand alone years later.

For every durable piece of information, emit:
- "subject": the full display name of the person the proposition is ABOUT (one of the participants, exactly as named);
- "aspect": one slug from: identity, residence, family, relationships, pets, activities, work, education, health, possessions, events, plans, preferences, media, travel, other;
- "proposition": ONE self-contained sentence. Resolve every pronoun and deictic reference ("it", "there", "she", "the kitty") to the concrete name or thing using the WHOLE session. Include absolute dates: resolve relative expressions ("last week", "next month") against the session date. Enumerate list answers completely ("X's pets are the cats Luna and Oliver and the dog Bailey"), never partially.
- "occurred_on": the ISO date (YYYY-MM-DD) the described event happened, when determinable, else null;
- "turns": the turn numbers this proposition is grounded in.

Rules: be exhaustive — a missed fact is worse than a redundant one; state ONLY what the session supports, never invent; skip pure smalltalk and pleasantries. Emit up to 40 propositions. Output strictly the JSON schema.`;

/**
 * E3a assistant-content section (DERIVER_ASSISTANT_CONTENT). The base
 * contract is user-fact-shaped ("the person the proposition is ABOUT"),
 * so substantive content the assistant CONTRIBUTED — recommendations,
 * answers, instructions — structurally never becomes a proposition.
 * That is the measured SSA failure ("facts do not specify…" while the
 * verbatim turn sits in L0) at the substrate level; the read-side
 * verbatim lane routes around it, this closes it at the source.
 * Flag-gated, default off: deriver prompt changes need a paid confirm
 * leg on a FRESH derivedVersion (worlds derived under different prompts
 * must not share a version).
 */
export const DERIVER_ASSISTANT_SECTION = `

ASSISTANT-SIDE CONTRIBUTIONS
Also emit propositions for substantive content a participant CONTRIBUTED to the other: recommendations made, answers and explanations given, instructions or steps provided, plans proposed. Use aspect "assistance", subject = the CONTRIBUTING participant, and state specifically WHAT was recommended/explained and to whom ("Assistant recommended the token-bucket algorithm to Alex for API rate limiting"). Keep the concrete payload — names, numbers, steps, code identifiers — because a later question will ask "what did you suggest…" and ONLY this proposition will be available to answer it.`;

/**
 * Multiworld §10 item 2 (DERIVER_TYPED_ATOMS) — the typed single-pass
 * derive. One extraction pass, typed atom stream: every proposition
 * carries `kind`, so read-side worlds become TYPED LANES over one
 * substrate instead of N derive passes (the pattern every ablation-
 * grade multi-view system uses — Hindsight/MemIR/O-Mem type one pass).
 * The assistant_contribution rules subsume DERIVER_ASSISTANT_SECTION:
 * that content class must be EMITTED before it can be tagged.
 */

/**
 * The closed kind vocabulary — the response-schema enum AND the row
 * builder's stamp gate read this one set, so prompt, schema and stamp
 * can never drift; an off-contract reply value is dropped, never
 * stored as a surprise lane.
 */
export const TYPED_ATOM_KINDS: ReadonlySet<string> = new Set([
  'fact',
  'assistant_contribution',
  'persona_attr',
  'event',
]);

/** The row builder's stamp gate (FLEXIBLE-source ride): flag on AND an
 *  on-contract kind, else the row stays untyped. */
export function typedAtomKind(p: { kind?: string }): { kind?: string } {
  return resolveExtractionProfile().deriveTypedAtoms && p.kind && TYPED_ATOM_KINDS.has(p.kind)
    ? { kind: p.kind }
    : {};
}

export const DERIVER_TYPED_SECTION = `

ATOM TYPES
Tag every proposition with "kind" — exactly one of:
- "fact" — a durable fact about a participant (the default when nothing below applies);
- "assistant_contribution" — substantive content one participant CONTRIBUTED to the other: a recommendation made, an answer or explanation given, instructions or steps provided, a plan proposed. Subject = the CONTRIBUTING participant; keep the concrete payload — names, numbers, steps, code identifiers — a later "what did you suggest…" question will have ONLY this proposition to answer from;
- "persona_attr" — a stable trait, preference, identity or self-description of a participant;
- "event" — something that HAPPENED at a determinable time (occurrences, milestones, incidents).
When several could apply, prefer assistant_contribution, then event, then persona_attr, then fact.`;

/**
 * V12 §3 event-dating rules (DERIVER_DATE_RESOLVE) — the graphiti
 * anti-collapse port for `occurred_on`. The base contract's one-liner
 * ("when determinable, else null") measures as a session-date
 * collapse: relative expressions land on the day of the CONVERSATION
 * and "when did X happen" answers come out off by days (the armD miss
 * class: gold "7 May" → answered the session date). Flag-gated,
 * default off: a prompt change confirms only on a FRESH
 * derivedVersion.
 */
export const DERIVER_DATE_SECTION = `

EVENT DATING
"occurred_on" dates the EVENT, never the conversation:
- Resolve relative time by calendar arithmetic from the session date: "yesterday" on 2023-05-08 is 2023-05-07; "last Friday", "two weekends ago", "next month" resolve the same way. Never copy the session date for an event that merely got MENTIONED that day.
- Use the session date ONLY for events that happened during the session's own day ("today I…", "this morning").
- Planned or future events: date the planned occurrence when it is stated or derivable ("next Friday" → that Friday's date).
- Month-only knowledge resolves to the FIRST day of that month ("in June" → 2023-06-01); year-only to January 1st. This is a rendering convention, not a precision claim.
- When the event time is genuinely undeterminable, use null — a wrong default is worse than no date.`;

/**
 * G3 char-span provenance (DERIVER_SPANS, sota-gap-build-2026-08): the
 * deriver also fills `quotes` — one verbatim supporting snippet per
 * grounding turn, parallel to `turns`. The LLM cannot emit reliable
 * character offsets, so it QUOTES; the row builder verifies each quote
 * mechanically against the stored turn text and computes the offsets
 * itself (span-anchor.ts). A quote that fails verification silently
 * contributes no span — the fact always lands. Flag-gated, default
 * off: a prompt + schema change confirms only on a FRESH
 * derivedVersion.
 */
export const DERIVER_QUOTES_SECTION = `

GROUNDING QUOTES
For every proposition also fill "quotes" — an array PARALLEL to "turns": for each grounding turn, the shortest VERBATIM snippet from that turn's text that supports the proposition, copied character-for-character (never paraphrased, never spanning multiple turns, never including the [N] / speaker prefix). Use null for a turn with no single verbatim supporting snippet. "quotes" must have exactly as many entries as "turns".`;

/**
 * V13 date audit (DERIVER_DATE_AUDIT) — the post-pass shape of the
 * failed in-prompt date rules. Measured lineage: prose rules inside
 * the extraction prompt moved NOTHING (wd-v4 date distribution
 * byte-equal to the replicates, armH null), while the same contract as
 * a dedicated after-emission turn is exactly how salience grading
 * succeeded after ITS in-prompt version failed both gates (V8 §4 →
 * V9 §5). One extra cheap call per session; failure degrades to the
 * un-audited dates.
 */
export const DATE_AUDIT_SYSTEM = `You audit the event dates of memory propositions extracted from ONE dated dialogue session. For every numbered proposition decide "occurred_on" — the ISO date (YYYY-MM-DD) the described EVENT actually happened:
- Resolve relative expressions from the transcript ("yesterday", "last Friday", "two weekends ago", "next month") by calendar arithmetic from the session date.
- The session date is correct ONLY for events that happened during that same day ("today I…", "this morning").
- Planned or future events take the planned occurrence date when stated or derivable.
- Month-only knowledge resolves to the FIRST day of that month; year-only to January 1st.
- Genuinely undeterminable: null. A wrong default is worse than no date.
Return a decision for EVERY index. Output strictly the JSON schema.`;

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function auditDates(
  deps: DeriverClientDeps,
  args: {
    sessionDate: Date;
    /** The base deriver conversation — continued, not re-prefixed, so
     *  the transcript (the dominant token mass) stays a prompt-cache
     *  hit like completionUnion's continuation 30 lines up. */
    messages: ChatMessage[];
    propositions: DerivedProposition[];
  },
): Promise<void> {
  try {
    const list = args.propositions
      .map(
        (p, i) =>
          `${i}. [${p.subject}] ${p.proposition} (current occurred_on: ${p.occurred_on ?? 'null'})`,
      )
      .join('\n');
    const res = await deps.openai.chat.completions.create({
      model: deps.model,
      ...chatCallParams(deps.model, { temperature: 0, visibleCap: 4000 }),
      messages: [
        ...args.messages,
        { role: 'assistant', content: `Propositions:\n${list}` },
        {
          role: 'user',
          content: `${DATE_AUDIT_SYSTEM}\n\nSession date: ${args.sessionDate.toISOString().slice(0, 10)}. Audit the numbered propositions above.`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'date_audit',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              dates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    occurred_on: { type: ['string', 'null'] },
                  },
                  required: ['index', 'occurred_on'],
                },
              },
            },
            required: ['dates'],
          },
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty date-audit response');
    const parsed = JSON.parse(content) as {
      dates?: Array<{ index: number; occurred_on: string | null }>;
    };
    const dates = parsed.dates ?? [];
    // An index === length entry is the perfect tell of a 1-based reply:
    // applying a shifted map would stamp every proposition with its
    // NEIGHBOR'S date — strictly worse than the un-audited baseline the
    // degrade contract promises. Abort the whole application.
    if (dates.some((d) => d.index === args.propositions.length)) {
      deps.logger.warn('date audit reply looks 1-based (index === length) — discarding the audit');
      return;
    }
    for (const d of dates) {
      if (!Number.isInteger(d.index) || d.index < 0 || d.index >= args.propositions.length) {
        continue;
      }
      // d.index validated in-bounds by the guard above ⇒ prop is present.
      const prop = args.propositions[d.index]!;
      // Apply BOTH values and explicit nulls — clearing a fabricated
      // session-date default is the audit's whole point. The cleared
      // marker survives to the row builder, which renders "undated" as
      // the epoch sentinel instead of the session-date fallback.
      if (d.occurred_on === null) {
        prop.occurred_on = null;
        prop.dateCleared = true;
      } else if (
        typeof d.occurred_on === 'string' &&
        ISO_DAY_RE.test(d.occurred_on) &&
        // Calendar round-trip — the same guard the row builder uses:
        // shape-only acceptance let an impossible date ('2023-02-30')
        // overwrite a CORRECT one and then silently collapse to the
        // session date downstream.
        new Date(`${d.occurred_on}T00:00:00.000Z`).toISOString().slice(0, 10) === d.occurred_on
      ) {
        prop.occurred_on = d.occurred_on;
        prop.dateCleared = false;
      }
    }
  } catch (e) {
    deps.logger.warn(`date audit turn failed (${(e as Error).message}); dates stay un-audited`);
  }
}

/**
 * Salience grading (DERIVER_SALIENCE_STAMP, V8 §4 → V9 §5 rebuild):
 * a SEPARATE cheap turn over the emitted proposition list. The V8
 * in-prompt section failed both its gates — it primed over-emission
 * (+54-74% propositions vs the same env without it: NOT recall-
 * neutral) and inflated the grade mass (0.4/36/52/11.7% vs the
 * ~10/60/25/5 rubric). Grading AFTER emission is volume-neutral by
 * construction, and a rubric with explicit mass targets is the
 * distribution fix. Failure degrades to unstamped rows.
 */
export const SALIENCE_GRADING_SYSTEM = `You grade the long-term SALIENCE of memory propositions about a person — how central each is to remembering them years later.

Grades and their expected share of a typical list:
- 0 = incidental detail (smalltalk-adjacent, one-off logistics, weather) — about 10%;
- 1 = routine fact (ordinary activities, minor preferences, passing mentions) — the default, about 60%;
- 2 = notable (decisions, changes, plans, milestones, recurring topics) — about 25%;
- 3 = identity-central (job, family, health, home, long-term goals — the few facts a biographer would keep) — about 5%.

Grade EVERY numbered proposition. Hold the proportions unless the list is genuinely atypical — a list where most grades are 2-3 is almost always inflation, not an exceptional person. Output strictly the JSON schema.`;

/**
 * V13 structural event-time grounding (DERIVER_TURN_HEADERS) — the
 * graphiti reference_time prompt shape. The measured mention-collapse
 * (one "Session date:" line for the whole session) leaves the model no
 * per-turn anchor, so multi-day sessions and "yesterday" said late in a
 * session date wrong. This section pairs with the per-turn timestamp
 * render in the transcript itself. The session-date convention for
 * same-day events stays (armK: removing it measured −4.9 — that
 * default IS the answer convention of dialogue benchmarks).
 */
export const DERIVER_TURN_TIME_SECTION = `

TURN TIMESTAMPS
Each transcript line carries its own timestamp: [N] (YYYY-MM-DD HH:MM) speaker: text.
- Resolve relative time expressions against the timestamp of the turn that SAYS them, not the session's first day: "yesterday" in a turn stamped 2023-05-08 is 2023-05-07 even when the session started 2023-05-07.
- When turns span more than one calendar day, date each proposition's event from ITS grounding turns' timestamps.
- Events that happened during a turn's own day ("today I…", "this morning") date to that turn's calendar day — this rule is unchanged.`;

/**
 * V13 scene traces (DERIVER_SCENE_TRACE) — the dual-trace encoding
 * port (arXiv 2604.12948: fact + a concrete trace of the context it
 * was learned in; +20.2pp LongMemEval-S, temporal +40pp, in their
 * controlled pair). Encoding specificity in pure text: the trace
 * binds the fact to its situation, which is what makes it findable
 * from situational questions the bare proposition never matches.
 */
export const DERIVER_SCENE_SECTION = `

SCENE TRACES
For every proposition also fill "scene": ONE short clause capturing the concrete situation in which this was learned — the occasion, activity or exchange it surfaced in ("while planning the Portland trip with her sister", "reacting to the failed job interview"). Ground it in the session; name the concrete occasion, never a generic one ("during the conversation" is always wrong). Use null only when the session gives no situational context at all.`;

/** System prompt assembly; each section only exists when its flag asks. */
export function buildDeriverSystem(opts?: {
  assistantContent?: boolean;
  dateResolve?: boolean;
  turnHeaders?: boolean;
  sceneTrace?: boolean;
  typedAtoms?: boolean;
  spans?: boolean;
}): string {
  return (
    DERIVER_SYSTEM +
    (opts?.assistantContent ? DERIVER_ASSISTANT_SECTION : '') +
    (opts?.typedAtoms ? DERIVER_TYPED_SECTION : '') +
    (opts?.dateResolve ? DERIVER_DATE_SECTION : '') +
    (opts?.turnHeaders ? DERIVER_TURN_TIME_SECTION : '') +
    (opts?.sceneTrace ? DERIVER_SCENE_SECTION : '') +
    (opts?.spans ? DERIVER_QUOTES_SECTION : '')
  );
}

/**
 * V7 deriver-recall (DERIVER_COMPLETION_PASS): the follow-up turn of
 * the completion pass. The base contract caps at 40 propositions and a
 * single pass measurably under-extracts dense sessions (the LoCoMo
 * bottleneck has been extraction recall since 2026-07); asking the
 * SAME model to diff its own output against the transcript is the
 * cheapest recall pass — it sees what it already said, so the union is
 * additive, not a re-roll.
 */
export const DERIVER_COMPLETION_PROMPT = `Review the transcript once more against the propositions you just emitted. Emit ONLY durable propositions that are MISSING from your list: facts, events, dates, plans, preferences, media titles, list members, and (when the assistance rules above apply) contributed content that no emitted proposition captures. Do NOT repeat or rephrase anything already emitted. Same output contract (subject / aspect / proposition / occurred_on / turns). Up to 20 additional propositions; return an empty list if nothing was missed.`;

/** Dedup key for the completion-pass union: subject + normalized text. */
export function propositionKey(p: { subject: string; proposition: string }): string {
  const norm = p.proposition
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.\s*$/, '')
    .trim();
  return `${p.subject.toLowerCase().trim()}\x00${norm}`;
}

export interface DerivedProposition {
  subject: string;
  aspect: string;
  proposition: string;
  occurred_on: string | null;
  /** V13 scene trace (DERIVER_SCENE_TRACE): one clause of encoding
   *  context — the situation in which this was learned. */
  scene?: string | null;
  /** Multiworld §10 typed atom kind (DERIVER_TYPED_ATOMS); stored as
   *  source.kind after the row builder validates it against the set. */
  kind?: string;
  /** V13 date audit: the audit EXPLICITLY cleared a fabricated date —
   *  the row builder must express "undated" (epoch sentinel), never
   *  fall back to the session date it just removed. */
  dateCleared?: boolean;
  turns: number[];
  /** G3 (DERIVER_SPANS): verbatim supporting snippet per grounding
   *  turn, PARALLEL to `turns` (null = no snippet for that turn). The
   *  row builder verifies each mechanically → source.charSpans. */
  quotes?: Array<string | null>;
  /** 0-3 importance grade; present only under DERIVER_SALIENCE_STAMP. */
  salience?: number;
}

export interface DeriverClientDeps {
  openai: OpenAI;
  model: string;
  logger: { warn(m: string): void; log(m: string): void };
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * One session's full extraction: base pass → optional completion-pass
 * union → optional salience grading turn (V9 §5: grades come from a
 * SEPARATE turn over the final list — the extraction passes never see
 * the word "salience", so emission volume is untouched).
 */
export async function callDeriver(
  deps: DeriverClientDeps,
  args: {
    sessionDate: Date;
    participants: string[];
    transcript: string[];
  },
): Promise<DerivedProposition[]> {
  const profile = resolveExtractionProfile();
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildDeriverSystem({
        assistantContent: profile.deriveAssistantContent,
        dateResolve: profile.deriveDateResolve,
        turnHeaders: profile.deriveTurnHeaders,
        sceneTrace: profile.deriveSceneTrace,
        typedAtoms: profile.deriveTypedAtoms,
        spans: profile.deriveSpans,
      }),
    },
    {
      role: 'user',
      content: `Session date: ${args.sessionDate.toISOString().slice(0, 10)}\nParticipants: ${args.participants.join(', ')}\n\nTranscript:\n${args.transcript.join('\n')}`,
    },
  ];
  const base = await deriverPass(deps, messages);
  const merged = await completionUnion(deps, { profile, messages, base });
  if (profile.deriveDateAudit && merged.length > 0) {
    await auditDates(deps, {
      sessionDate: args.sessionDate,
      messages,
      propositions: merged,
    });
  }
  if (profile.deriveSalienceStamp && merged.length > 0) {
    await gradeSalience(deps, merged);
  }
  return merged;
}

/** V7 completion pass, additive by construction — a failure degrades
 *  to the base pass, never fails the session. */
async function completionUnion(
  deps: DeriverClientDeps,
  {
    profile,
    messages,
    base,
  }: {
    profile: ReturnType<typeof resolveExtractionProfile>;
    messages: ChatMessage[];
    base: DerivedProposition[];
  },
): Promise<DerivedProposition[]> {
  if (!profile.deriveCompletionPass || base.length === 0) return base;
  let extra: DerivedProposition[] = [];
  try {
    extra = await deriverPass(deps, [
      ...messages,
      {
        role: 'assistant',
        content: JSON.stringify({ propositions: base }),
      },
      { role: 'user', content: DERIVER_COMPLETION_PROMPT },
    ]);
  } catch (e) {
    deps.logger.warn(
      `deriver completion pass failed (${(e as Error).message}); keeping the base pass`,
    );
  }
  const seen = new Set(base.map(propositionKey));
  const merged = [...base];
  for (const p of extra) {
    const k = propositionKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(p);
  }
  if (merged.length > base.length) {
    deps.logger.log(
      `deriver completion pass added ${merged.length - base.length} proposition(s) (base ${base.length})`,
    );
  }
  return merged;
}

/**
 * V9 §5: the volume-neutral grading turn. Mutates `propositions` in
 * place (stamps `salience` 0-3 by index); any failure or an
 * index/length mismatch leaves rows unstamped — the scoring side
 * treats missing stamps as neutral.
 */
async function gradeSalience(
  deps: DeriverClientDeps,
  propositions: DerivedProposition[],
): Promise<void> {
  try {
    const list = propositions.map((p, i) => `${i}. [${p.subject}] ${p.proposition}`).join('\n');
    const res = await deps.openai.chat.completions.create({
      model: deps.model,
      ...chatCallParams(deps.model, { temperature: 0, visibleCap: 4000 }),
      messages: [
        { role: 'system', content: SALIENCE_GRADING_SYSTEM },
        { role: 'user', content: `Propositions:\n${list}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'salience_grades',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              grades: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    salience: { type: 'integer' },
                  },
                  required: ['index', 'salience'],
                },
              },
            },
            required: ['grades'],
          },
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty grading response');
    const parsed = JSON.parse(content) as {
      grades?: Array<{ index: number; salience: number }>;
    };
    for (const g of parsed.grades ?? []) {
      if (
        Number.isInteger(g.index) &&
        g.index >= 0 &&
        g.index < propositions.length &&
        Number.isInteger(g.salience) &&
        g.salience >= 0 &&
        g.salience <= 3
      ) {
        propositions[g.index]!.salience = g.salience; // g.index validated above
      }
    }
  } catch (e) {
    deps.logger.warn(`salience grading turn failed (${(e as Error).message}); rows stay unstamped`);
  }
}

/**
 * V13 cross-session composition (DERIVER_COMPOSE_PASS) — the PREMem
 * shape (EMNLP 2025 Findings 2509.10852): reasoning moved to memory
 * CONSTRUCTION. The measured largest miss bucket is multi-hop golds
 * where every atom exists and no atom states the combination; the
 * mechanical per-aspect rollup (armL) measured negative, and the graph
 * literature's on-genre verdict is "assemble the chain at write time
 * or by read-time iteration — never by static traversal". This is the
 * write-time half: one extra call per CONVERSATION over the landed
 * atoms of all its sessions, emitting only multi-atom compositions.
 */
export const COMPOSE_SYSTEM = `You compose HIGHER-ORDER memory propositions from one conversation's atomic propositions (extracted across multiple dated sessions). Emit ONLY propositions that COMBINE two or more atoms into a durable fact that NO single atom states:
- accumulation: the complete list gathered across sessions ("X's pets are A, B and C");
- transformation: a value that changed, with both states and dates ("X moved from A (date1) to B (date2)");
- specification: a general fact merged with its later concrete detail;
- connection: a cause/enable/purpose link the atoms explicitly support.

Rules: every composition must be fully supported by its member atoms — never bridge with outside knowledge; carry the members' absolute dates into the text; skip anything a single atom already states; skip near-duplicates of another composition; never blend atoms about DIFFERENT people into one claim unless the composition states the relationship between them explicitly. "members" lists the atom numbers used (two or more distinct). "occurred_on" dates the composed event when determinable, else null. Up to 20 compositions; an empty list is the correct output when nothing composes.`;

/** One composed row proposal from the cross-session pass. */
export interface ComposedProposition {
  aspect: string;
  proposition: string;
  occurred_on: string | null;
  members: number[];
}

/**
 * The cross-session composition call. Atoms render as a numbered dated
 * list; the reply's member indices are validated by the caller (a
 * composition keeps only in-range members and needs ≥2 to land).
 * Throws on transport/parse errors — the caller degrades to zero
 * composed rows; the atomic facts already landed.
 */
export async function composeCrossSession(
  deps: DeriverClientDeps,
  args: {
    atoms: Array<{
      entity: string;
      predicate: string;
      object: string;
      dateIso: string | null;
    }>;
  },
): Promise<ComposedProposition[]> {
  const list = args.atoms
    .map(
      (a, i) =>
        `${i}. [${a.entity}/${a.predicate}]${a.dateIso ? ` (${a.dateIso})` : ''} ${a.object}`,
    )
    .join('\n');
  const res = await deps.openai.chat.completions.create({
    model: deps.model,
    ...chatCallParams(deps.model, { temperature: 0, visibleCap: 6000 }),
    messages: [
      { role: 'system', content: COMPOSE_SYSTEM },
      { role: 'user', content: `Atomic propositions:\n${list}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'composed_propositions',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            compositions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  aspect: { type: 'string' },
                  proposition: { type: 'string' },
                  occurred_on: { type: ['string', 'null'] },
                  members: { type: 'array', items: { type: 'integer' } },
                },
                required: ['aspect', 'proposition', 'occurred_on', 'members'],
              },
            },
          },
          required: ['compositions'],
        },
      },
    },
  });
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error('empty composition response');
  const parsed = JSON.parse(content) as {
    compositions?: ComposedProposition[];
  };
  return Array.isArray(parsed.compositions) ? parsed.compositions : [];
}

/**
 * One structured deriver call with an explicit truncation guard: a
 * finish_reason='length' response is a SILENT recall hole (the JSON
 * either fails to parse — failing the session — or the model
 * self-limits and the tail propositions never exist). Retry once at
 * a doubled cap; a still-truncated response throws (fail-loud, the
 * derive driver resumes).
 */
async function deriverPass(
  deps: DeriverClientDeps,
  messages: ChatMessage[],
): Promise<DerivedProposition[]> {
  for (const maxTokens of [8000, 16000]) {
    const res = await deriverRequest(deps, messages, maxTokens);
    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') {
      deps.logger.warn(
        `deriver response truncated at ${maxTokens} tokens — retrying with a larger cap`,
      );
      continue;
    }
    const content = choice?.message?.content;
    if (!content) throw new Error('empty deriver response');
    const parsed = JSON.parse(content) as {
      propositions?: DerivedProposition[];
    };
    return Array.isArray(parsed.propositions) ? parsed.propositions : [];
  }
  throw new Error('deriver response truncated at 16000 tokens');
}

function deriverRequest(deps: DeriverClientDeps, messages: ChatMessage[], maxTokens: number) {
  // V9 §5: the extraction schema no longer carries salience — grades
  // come from the separate post-emission turn (gradeSalience), so
  // the extraction call is byte-identical with the stamp flag on or
  // off (volume-neutral by construction).
  // V13 scene traces: the `scene` field exists in the schema ONLY
  // under DERIVER_SCENE_TRACE — off keeps the schema byte-identical.
  // Multiworld §10: `kind` exists ONLY under DERIVER_TYPED_ATOMS —
  // same conditional-schema idiom.
  // G3: `quotes` exists ONLY under DERIVER_SPANS — same idiom again.
  const profile = resolveExtractionProfile();
  const sceneTrace = profile.deriveSceneTrace;
  const typedAtoms = profile.deriveTypedAtoms;
  const spans = profile.deriveSpans;
  return deps.openai.chat.completions.create({
    model: deps.model,
    ...chatCallParams(deps.model, { temperature: 0.1, visibleCap: maxTokens }),
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'session_propositions',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            propositions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  subject: { type: 'string' },
                  aspect: { type: 'string' },
                  proposition: { type: 'string' },
                  occurred_on: { type: ['string', 'null'] },
                  // minItems 1 (audit 2026-08-21 P0): an ungrounded
                  // proposition has no scope evidence — the row builder
                  // fail-closed-drops it, and the schema refuses it at
                  // the source.
                  turns: {
                    type: 'array',
                    items: { type: 'integer' },
                    minItems: 1,
                  },
                  ...(sceneTrace ? { scene: { type: ['string', 'null'] } } : {}),
                  ...(typedAtoms
                    ? {
                        kind: {
                          type: 'string',
                          enum: [...TYPED_ATOM_KINDS],
                        },
                      }
                    : {}),
                  // G3: one verbatim snippet (or null) per grounding
                  // turn, parallel to `turns` — the server anchors.
                  ...(spans
                    ? {
                        quotes: {
                          type: 'array',
                          items: { type: ['string', 'null'] },
                        },
                      }
                    : {}),
                },
                required: [
                  'subject',
                  'aspect',
                  'proposition',
                  'occurred_on',
                  'turns',
                  ...(sceneTrace ? ['scene'] : []),
                  ...(typedAtoms ? ['kind'] : []),
                  ...(spans ? ['quotes'] : []),
                ],
              },
            },
          },
          required: ['propositions'],
        },
      },
    },
  });
}

/**
 * V12 §2 (the graphiti saga merge contract, adapted): fold ONE session
 * into the rolling conversation digest. The digest is the narrative
 * arc — how topics evolved, with dates — the summarization golds ask
 * for and fact extraction keeps thinnest (the earliest exploratory
 * beats). Bounded state, one call per session, chronological fold
 * order is the caller's contract.
 */
export const DIGEST_MERGE_SYSTEM = `You maintain a rolling digest of ONE ongoing conversation.

Input: the EXISTING DIGEST (may be empty) and one SESSION transcript with its date.
Merge the session's durable content into the digest and output the FULL updated digest text, nothing else.

Rules:
- Narrative and chronological: keep the story of how topics and projects EVOLVED, with day stamps like [2026-03-15] on each beat. Early beats stay in the digest — do not drop history when adding new beats.
- Durable facts only. When newer content contradicts an earlier beat, keep both with their dates ("switched from X to Y").
- If the session adds no durable content, return the existing digest unchanged.
- No meta-language: never "mentioned", "discussed", "stated", "asked about" — write the facts and events themselves.
- PLAIN PROSE ONLY. Never reproduce code, templates, markup, tables, config or command output from the session — describe what it does in one clause ("built the transactions page template with per-row categories") instead. A digest containing a code block is ALWAYS wrong.
- Preserve names, dates, counts, versions and temporal qualifiers exactly.
- Keep the whole digest under 250 words; compress the least-informative old beats first, never the dated skeleton.`;

/** Hard cap on stored digest text — the prompt asks for ~250 words;
 *  this is the belt for prompt-escape (chars, not tokens). */
export const DIGEST_CHAR_CAP = 2400;

export async function foldDigest(
  deps: DeriverClientDeps,
  args: { existing: string; sessionDate: Date; transcript: string[] },
): Promise<string> {
  const day = args.sessionDate.toISOString().slice(0, 10);
  const res = await deps.openai.chat.completions.create({
    model: deps.model,
    ...chatCallParams(deps.model, { temperature: 0.1, visibleCap: 1200 }),
    messages: [
      { role: 'system', content: DIGEST_MERGE_SYSTEM },
      {
        role: 'user',
        content:
          `EXISTING DIGEST:\n${args.existing || '(empty)'}\n\n` +
          `SESSION [${day}]:\n${args.transcript.join('\n')}`,
      },
    ],
  });
  const text = (res.choices[0]?.message?.content ?? '').trim();
  // A degrade must never ERASE the digest — an empty/failed fold keeps
  // the previous state (same contract as the salience grading turn).
  if (!text) return args.existing;
  // Prompt-escape belt (measured live on the first wd-v12 tenants: a
  // mini model echoed a Jinja template from a code-heavy session as
  // the whole "digest"). Markup/code output is ALWAYS wrong here —
  // keep the previous state instead of poisoning every later fold.
  if (/```|\{%|<\/?[a-z][a-z0-9]*[\s>]/i.test(text)) {
    deps.logger.warn('digest fold returned code/markup — keeping the previous state');
    return args.existing;
  }
  if (text.length <= DIGEST_CHAR_CAP) return text;
  // Over budget: hard-truncating the TAIL would eat the NEWEST beats
  // (measured on the first wd-v12 tenants — the digest ended mid-word
  // inside the latest session). One compress turn owns the trade-off;
  // the hard cap stays as the last belt only.
  const compressed = await deps.openai.chat.completions
    .create({
      model: deps.model,
      ...chatCallParams(deps.model, { temperature: 0.1, visibleCap: 1200 }),
      messages: [
        { role: 'system', content: DIGEST_MERGE_SYSTEM },
        {
          role: 'user',
          content:
            'This digest exceeds the budget. Rewrite it UNDER 250 words: ' +
            'merge the oldest and least-informative beats into fewer summary ' +
            'beats; PRESERVE every beat from the most recent sessions and ' +
            'the dated skeleton.\n\n' +
            text,
        },
      ],
    })
    .then((r) => (r.choices[0]?.message?.content ?? '').trim())
    .catch(() => '');
  const final = compressed && compressed.length <= text.length ? compressed : text;
  return final.length > DIGEST_CHAR_CAP ? `${final.slice(0, DIGEST_CHAR_CAP - 1)}…` : final;
}
