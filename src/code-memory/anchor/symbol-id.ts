/**
 * Code anchor id format (code-memory Phase 2). An anchor addresses either a
 * whole file or a symbol within it:
 *   file-level    → "src/x.ts"
 *   symbol-level  → "src/x.ts#FactResolverService.resolve"
 * The `#` separates path from the SCIP-style dotted symbol path. Symbol anchors
 * survive line shifts + file-internal moves; a file move still needs a
 * re-anchor (Phase 2b sweep).
 */

const SYMBOL_SEP = '#';

export function symbolAnchorId(path: string, symbolPath: string): string {
  return `${path}${SYMBOL_SEP}${symbolPath}`;
}

export function parseAnchor(anchor: string): {
  path: string;
  symbolPath?: string;
} {
  const i = anchor.indexOf(SYMBOL_SEP);
  if (i === -1) return { path: anchor };
  return { path: anchor.slice(0, i), symbolPath: anchor.slice(i + 1) };
}

export function isSymbolAnchor(anchor: string): boolean {
  return anchor.includes(SYMBOL_SEP);
}
