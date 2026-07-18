/**
 * LoCoMo (Long-term Conversational Memory) dataset types.
 *
 * Source: Snap Research, Maharana et al. "Evaluating Very Long-Term
 * Conversational Memory of LLM Agents" (2024).
 * https://github.com/snap-research/locomo
 *
 * The dataset ships 10 multi-session conversations between two
 * speakers. Each conversation runs ~35 sessions and ~600 turns. Each
 * sample carries a QA set across 5 categories testing different
 * memory regimes — single-hop recall, multi-hop synthesis, temporal
 * reasoning, open-domain commonsense, and adversarial (questions the
 * agent should NOT answer because the evidence supports a "don't
 * know").
 *
 * We don't ship the dataset — it's CC-BY-4.0, the user downloads from
 * the upstream repo and points the runner at the JSON file. See
 * docs/locomo.md for the procurement step.
 */

/** A single utterance in the conversation. */
export interface LocomoTurn {
  /** Dialogue id within the session — e.g. "D1:5" (session 1, turn 5). */
  dia_id: string;
  speaker: string;
  text: string;
  /** Optional image attachment URL (some turns are multimodal). */
  img_url?: string;
  /** Caption that accompanies an attached image. */
  blip_caption?: string;
}

/**
 * One LoCoMo sample = one extended conversation + an associated QA
 * battery. The conversation is keyed by `session_<N>` with the date
 * exposed as `session_<N>_date_time`. We model this as a normalized
 * shape so the loader does the awkward un-keying once.
 */
export interface LocomoRawConversation {
  speaker_a: string;
  speaker_b: string;
  /** session_N → turns, session_N_date_time → ISO string. */
  [key: string]: unknown;
}

export interface LocomoSession {
  index: number;
  /** ISO datetime when this session occurred — drives `validFrom`. */
  dateTime: string;
  turns: LocomoTurn[];
}

export type LocomoQACategory =
  /** category 1 — single-hop: answer is in one turn. */
  | 1
  /** category 2 — multi-hop: requires joining evidence across turns. */
  | 2
  /** category 3 — temporal: requires reasoning about WHEN something happened. */
  | 3
  /** category 4 — open-domain: requires commonsense beyond what's in the conversation. */
  | 4
  /**
   * category 5 — adversarial: the question presupposes something the
   * conversation never establishes; the agent must decline rather than
   * invent an answer. Upstream stores the tempting-but-wrong answer under
   * `adversarial_answer` and leaves `answer` absent. Per the official
   * LoCoMo protocol these are EXCLUDED from the headline accuracy
   * (score = correct(cat1-4) / total(cat1-4)) and reported separately as
   * an abstention rate. See docs/locomo.md.
   */
  | 5;

export interface LocomoQuestion {
  question: string;
  /**
   * Gold answer. Absent for adversarial (cat5) questions upstream — the
   * loader leaves it '' there and the runner scores cat5 on abstention,
   * not string overlap.
   */
  answer: string;
  category: LocomoQACategory;
  /**
   * The tempting-but-unsupported answer for adversarial (cat5) questions,
   * carried through for diagnostics/reporting. Absent for cat1-4.
   */
  adversarialAnswer?: string;
  /** Turn ids that the gold reasoning cites — useful for joint-F1 scoring. */
  evidence: string[];
}

export interface LocomoSample {
  sample_id: string;
  conversation: LocomoRawConversation;
  qa: LocomoQuestion[];
}

export interface LocomoDataset {
  samples: LocomoSample[];
}

/** Normalized conversation — what the runner actually consumes. */
export interface NormalizedConversation {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  sessions: LocomoSession[];
  qa: LocomoQuestion[];
}
