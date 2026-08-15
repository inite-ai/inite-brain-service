import type OpenAI from 'openai';
import {
  resolveExtractionProfile,
} from '../ai/extraction-profile';

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

/** System prompt assembly; each section only exists when its flag asks. */
export function buildDeriverSystem(opts?: {
  assistantContent?: boolean;
}): string {
  return (
    DERIVER_SYSTEM +
    (opts?.assistantContent ? DERIVER_ASSISTANT_SECTION : '')
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
export function propositionKey(p: {
  subject: string;
  proposition: string;
}): string {
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
  turns: number[];
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
      }),
    },
    {
      role: 'user',
      content: `Session date: ${args.sessionDate.toISOString().slice(0, 10)}\nParticipants: ${args.participants.join(', ')}\n\nTranscript:\n${args.transcript.join('\n')}`,
    },
  ];
  const base = await deriverPass(deps, messages);
  const merged = await completionUnion(deps, { profile, messages, base });
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
    const list = propositions
      .map((p, i) => `${i}. [${p.subject}] ${p.proposition}`)
      .join('\n');
    const res = await deps.openai.chat.completions.create({
      model: deps.model,
      temperature: 0,
      max_completion_tokens: 4000,
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
        propositions[g.index].salience = g.salience;
      }
    }
  } catch (e) {
    deps.logger.warn(
      `salience grading turn failed (${(e as Error).message}); rows stay unstamped`,
    );
  }
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

function deriverRequest(
  deps: DeriverClientDeps,
  messages: ChatMessage[],
  maxTokens: number,
) {
  // V9 §5: the extraction schema no longer carries salience — grades
  // come from the separate post-emission turn (gradeSalience), so
  // the extraction call is byte-identical with the stamp flag on or
  // off (volume-neutral by construction).
  return deps.openai.chat.completions.create({
    model: deps.model,
    temperature: 0.1,
    max_completion_tokens: maxTokens,
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
                  turns: { type: 'array', items: { type: 'integer' } },
                },
                required: [
                  'subject',
                  'aspect',
                  'proposition',
                  'occurred_on',
                  'turns',
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
    temperature: 0.1,
    max_completion_tokens: 1200,
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
    deps.logger.warn(
      'digest fold returned code/markup — keeping the previous state',
    );
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
      temperature: 0.1,
      max_completion_tokens: 1200,
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
  return final.length > DIGEST_CHAR_CAP
    ? `${final.slice(0, DIGEST_CHAR_CAP - 1)}…`
    : final;
}
