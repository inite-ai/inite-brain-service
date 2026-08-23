import { promises as fs } from 'node:fs';
import type {
  LocomoDataset,
  LocomoQuestion,
  LocomoRawConversation,
  LocomoSample,
  LocomoSession,
  NormalizedConversation,
} from './types';

/**
 * LoCoMo loader.
 *
 * The upstream JSON is keyed by `session_<N>` / `session_<N>_date_time`,
 * which is awkward to iterate against. We normalize once on load so
 * downstream code (ingest, runner, scorer) sees a clean
 * `sessions: LocomoSession[]` array sorted by index.
 *
 * Robust to two upstream shapes seen in the wild — `{ samples: [...] }`
 * and a raw top-level array. Newer dumps add a `qa` block per sample;
 * older ones split it into `qa.json`. We only handle the bundled form;
 * the split form requires a one-shot merge (see docs/locomo.md).
 */

export async function loadLocomoDataset(path: string): Promise<NormalizedConversation[]> {
  const raw = await fs.readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as LocomoDataset | LocomoSample[];
  const samples: LocomoSample[] = Array.isArray(parsed) ? parsed : parsed.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(
      `Locomo loader: no samples found in ${path} — expected { samples: [...] } or top-level array`,
    );
  }
  return samples.map(normalizeSample);
}

export function normalizeSample(sample: LocomoSample): NormalizedConversation {
  const sessions = extractSessions(sample.conversation);
  return {
    sampleId: sample.sample_id,
    speakerA: sample.conversation.speaker_a,
    speakerB: sample.conversation.speaker_b,
    sessions,
    // LoCoMo gold answers are typed string, but the upstream JSON stores
    // some as numbers (counts, years) — `answer.toLowerCase()` in the
    // token-F1 scorer then throws. Coerce to string at the load boundary so
    // every downstream metric sees a string; null/undefined → '' (harmless).
    //
    // Adversarial (cat5) questions carry no `answer` — the tempting-but-
    // unsupported answer lives under the snake_case `adversarial_answer`.
    // Surface it as `adversarialAnswer` for diagnostics; the runner scores
    // cat5 on abstention, so `answer` staying '' is correct there.
    qa: sample.qa.map((q) => {
      const raw = q as LocomoQuestion & { adversarial_answer?: unknown };
      const adversarialAnswer =
        raw.adversarial_answer == null ? undefined : String(raw.adversarial_answer);
      return {
        ...q,
        answer: q.answer == null ? '' : String(q.answer),
        ...(adversarialAnswer !== undefined ? { adversarialAnswer } : {}),
      };
    }),
  };
}

function extractSessions(conv: LocomoRawConversation): LocomoSession[] {
  const sessions: LocomoSession[] = [];
  for (const key of Object.keys(conv)) {
    const match = key.match(/^session_(\d+)$/);
    if (!match) continue;
    const idx = parseInt(match[1]!, 10);
    const turnsValue = conv[key];
    if (!Array.isArray(turnsValue)) {
      throw new Error(`Locomo loader: session_${idx} is not an array — got ${typeof turnsValue}`);
    }
    const dateKey = `${key}_date_time`;
    const dateValue = conv[dateKey];
    const dateTime =
      typeof dateValue === 'string' ? toIsoOrPassthrough(dateValue) : new Date(0).toISOString();
    sessions.push({
      index: idx,
      dateTime,
      turns: turnsValue as LocomoSession['turns'],
    });
  }
  sessions.sort((a, b) => a.index - b.index);
  return sessions;
}

/**
 * LoCoMo dates come in two shapes: ISO-8601 and a human "1:56 pm on
 * 8 May, 2023" form. We pass ISO through (preserving its embedded
 * timezone); the human form is pinned to UTC so the run doesn't shift
 * day depending on the host's local timezone. Failure → epoch
 * fallback, so the runner can still partition by session order without
 * an exact timestamp.
 */
function toIsoOrPassthrough(value: string): string {
  // ISO-8601 with explicit zone — pass through, no TZ massage.
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(value.trim())) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // Human form: "1:56 pm on 8 May, 2023" or "8 May, 2023".
  // Append " UTC" so the JS Date parser pins the timezone — without
  // it the host's TZ silently shifts the day on CI machines.
  const cleaned = value.replace(/(\d+):(\d+) (am|pm) on /i, '$1:$2 $3, ');
  const utcDate = new Date(`${cleaned} UTC`);
  if (!Number.isNaN(utcDate.getTime())) return utcDate.toISOString();
  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) return fallback.toISOString();
  return new Date(0).toISOString();
}
