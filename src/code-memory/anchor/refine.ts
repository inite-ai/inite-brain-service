import type { DecisionCandidate } from '../capture/types';
import { parseAnchor, symbolAnchorId } from './symbol-id';
import { enclosingSymbol, listSymbols, symbolExists } from './ts-symbol-resolver';

/** Read a repo-relative file's current source, or null if it's gone. */
export type ReadFile = (path: string) => string | null;

/**
 * Upgrade a candidate's file-level anchor to a symbol anchor when the
 * LLM-proposed `symbol` actually resolves in the current file — grounding the
 * anchor so the model can't invent a symbol, and making it drift-resistant
 * (survives line shifts). Falls back to the file anchor when there's no symbol,
 * the file is unreadable, or the symbol doesn't resolve. Pure given `readFile`.
 */
export function makeSymbolAnchorRefiner(deps: {
  readFile: ReadFile;
}): (candidate: DecisionCandidate) => DecisionCandidate {
  return (candidate) => {
    if (!candidate.symbol) return candidate;
    const { path } = parseAnchor(candidate.anchor);
    const source = deps.readFile(path);
    if (!source) return candidate;
    if (!symbolExists(source, candidate.symbol, path)) return candidate;
    return { ...candidate, anchor: symbolAnchorId(path, candidate.symbol) };
  };
}

export type AnchorHealth = 'present' | 'symbol_missing' | 'file_gone';

/**
 * Drift check for a stored anchor against current code. A symbol anchor that
 * still resolves is `present` — line-independent, so in-file moves are invisible
 * (that's the whole point of symbol anchors); if the file exists but the symbol
 * is gone it's `symbol_missing` (a re-anchor candidate); if the file itself is
 * gone it's `file_gone`.
 */
export function validateAnchor(opts: {
  anchor: string;
  readFile: ReadFile;
}): AnchorHealth {
  const { path, symbolPath } = parseAnchor(opts.anchor);
  const source = opts.readFile(path);
  if (source === null) return 'file_gone';
  if (!symbolPath) return 'present';
  return symbolExists(source, symbolPath, path) ? 'present' : 'symbol_missing';
}

/**
 * Propose a replacement symbol for a `symbol_missing` anchor. `choose` is the
 * injected re-anchor decision (an LLM in production, per Magic Markup/Codetations
 * semantic re-anchoring) — it picks the current symbol that best matches the old
 * one, or null to leave the anchor stale (invalidate, never delete). We hand it
 * only the CURRENT symbol names, never source, keeping the hybrid contract.
 */
export function reanchor(opts: {
  source: string;
  path: string;
  missingSymbolPath: string;
  choose: (candidates: string[], missing: string) => string | null;
}): string | null {
  const candidates = listSymbols(opts.source, opts.path).map((s) => s.symbolPath);
  if (candidates.length === 0) return null;
  const picked = opts.choose(candidates, opts.missingSymbolPath);
  if (!picked || !candidates.includes(picked)) return null;
  return symbolAnchorId(opts.path, picked);
}

export { enclosingSymbol };
