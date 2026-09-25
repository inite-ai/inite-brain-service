/**
 * A document, cut into the raw turns the episodic substrate stores.
 *
 * Every raw read lane — source excerpts, raw windows, facts-as-keys
 * quotes, the episodic BM25 lane and L3's full sessions — reads L0
 * episodes, and reaches them through `knowledge_fact.source.episodeIds`.
 * The mention path captures its turn before extraction; a document
 * posted through `ingest_document` captured nothing, so every fact it
 * produced had no raw text behind it and every one of those lanes came
 * back empty. Measured on production: L3 fired on a question the
 * document answered verbatim and generated over 2 597 tokens — the fact
 * lines alone — because there was no session to lift.
 *
 * The cut follows the text's own structure. A chat transcript
 * ("Михаил: …", "Claude: …") is one turn per speaker line, the speaker
 * kept; anything else is its paragraphs, packed up to a size a quote
 * can carry. Offsets are kept so a fact's clause — a verbatim span of
 * the text, by the grounding gate — finds the turn it came from.
 */

export interface DocumentTurn {
  speaker?: string | undefined;
  text: string;
  /** Offset of the turn in the text it was cut from. */
  charStart: number;
}

/** A line that opens a speaker turn: a short name, a colon, the words. */
const SPEAKER_LINE = /^([^\n:]{1,60}?):[ \t]+\S/;
/** Paragraph packing target and hard ceiling for prose. */
const PARAGRAPH_TARGET = 1200;
const TURN_CEILING = 4000;

export function splitDocumentTurns(text: string): DocumentTurn[] {
  const lines = linesWithOffsets(text);
  const speakerLines = lines.filter((l) => SPEAKER_LINE.test(l.text));
  // A transcript: most non-empty lines open a turn. Two speaker lines in a
  // page of prose ("Note: …", "TODO: …") do not make it one.
  const nonEmpty = lines.filter((l) => l.text.trim() !== '').length;
  const isTranscript = speakerLines.length >= 2 && speakerLines.length * 2 >= nonEmpty;
  return (isTranscript ? speakerTurns(lines) : paragraphTurns(lines)).flatMap(capTurn);
}

/** The turn a verbatim span of the text came from, or -1. */
export function turnOfSpan(turns: readonly DocumentTurn[], span: string | undefined): number {
  const needle = span?.trim();
  if (!needle) return -1;
  return turns.findIndex((t) => t.text.includes(needle));
}

interface Line {
  text: string;
  start: number;
}

function linesWithOffsets(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const raw of text.split('\n')) {
    out.push({ text: raw, start });
    start += raw.length + 1;
  }
  return out;
}

function speakerTurns(lines: Line[]): DocumentTurn[] {
  const turns: DocumentTurn[] = [];
  for (const line of lines) {
    const m = SPEAKER_LINE.exec(line.text);
    const current = turns[turns.length - 1];
    if (m) {
      turns.push({ speaker: m[1]!.trim(), text: line.text, charStart: line.start });
    } else if (current) {
      current.text += `\n${line.text}`;
    } else if (line.text.trim() !== '') {
      // Text before the first speaker line — a heading, a preamble.
      turns.push({ text: line.text, charStart: line.start });
    }
  }
  return turns.map((t) => ({ ...t, text: t.text.trimEnd() })).filter((t) => t.text !== '');
}

function paragraphTurns(lines: Line[]): DocumentTurn[] {
  const paragraphs: DocumentTurn[] = [];
  let open: DocumentTurn | null = null;
  for (const line of lines) {
    if (line.text.trim() === '') {
      open = null;
      continue;
    }
    if (open) open.text += `\n${line.text}`;
    else {
      open = { text: line.text, charStart: line.start };
      paragraphs.push(open);
    }
  }
  // Short paragraphs travel together, so a quote carries its context.
  const packed: DocumentTurn[] = [];
  for (const p of paragraphs) {
    const last = packed[packed.length - 1];
    if (last && last.text.length + p.text.length + 2 <= PARAGRAPH_TARGET) {
      last.text += `\n\n${p.text}`;
    } else packed.push({ ...p });
  }
  return packed;
}

/** A turn no quote could carry is cut, never truncated: nothing is lost. */
function capTurn(t: DocumentTurn): DocumentTurn[] {
  if (t.text.length <= TURN_CEILING) return [t];
  const out: DocumentTurn[] = [];
  for (let at = 0; at < t.text.length; at += TURN_CEILING) {
    out.push({
      ...(t.speaker ? { speaker: t.speaker } : {}),
      text: t.text.slice(at, at + TURN_CEILING),
      charStart: t.charStart + at,
    });
  }
  return out;
}
