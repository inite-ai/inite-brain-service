import * as ts from 'typescript';

/**
 * Drift-resistant symbol resolution for TS/JS (code-memory Phase 2,
 * docs/roadmap/code-memory-domain.md). A code anchor keyed by a symbol PATH
 * (`FactResolverService.resolve`) survives line shifts and file moves for free —
 * unlike a line/offset anchor, which the research (Codetations / Magic Markup /
 * Catseye) shows is fragile under `git pull` / formatter runs.
 *
 * Uses the TypeScript compiler API (already a project dep) for an accurate AST
 * walk rather than a brittle regex scanner. Non-TS/JS files get no symbols —
 * the caller falls back to a file-level anchor. Runs CLIENT-SIDE in the capture
 * pipeline; only the resulting symbol-id string reaches the server.
 */

export interface SymbolSpan {
  /** Dotted path of enclosing named declarations, e.g. "Foo.bar". */
  symbolPath: string;
  kind: string;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
}

const TS_JS_EXT = /\.(mts|cts|tsx?|jsx?|mjs|cjs)$/i; // ts tsx mts cts js jsx mjs cjs

/**
 * Only TS/JS files get an AST symbol walk. Anything else (.py / .go / .rs / .md)
 * must NOT be fed to the TS parser: it would "succeed" and emit garbage symbol
 * spans from misparsed tokens, poisoning anchors. The docstring always promised
 * "non-TS/JS files get no symbols" — this enforces it.
 */
export function isTsJsSource(fileName: string): boolean {
  return TS_JS_EXT.test(fileName);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function declaredName(node: ts.Node): { name: string; kind: string } | null {
  if (ts.isClassDeclaration(node) && node.name) {
    return { name: node.name.text, kind: 'class' };
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { name: node.name.text, kind: 'function' };
  }
  if (ts.isConstructorDeclaration(node)) {
    return { name: 'constructor', kind: 'constructor' };
  }
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return { name: node.name.text, kind: 'method' };
  }
  // Top-level (or nested) `const foo = () => {}` / `const foo = function () {}`.
  if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      return { name: node.name.text, kind: 'function' };
    }
  }
  return null;
}

/** All named symbol spans in a source file, outermost-first. Non-TS/JS files
 *  get no symbols — the caller falls back to a file-level anchor. */
export function listSymbols(source: string, fileName = 'file.ts'): SymbolSpan[] {
  if (!isTsJsSource(fileName)) return [];
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const spans: SymbolSpan[] = [];
  const stack: string[] = [];

  const lineOf = (pos: number): number =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    const decl = declaredName(node);
    if (decl) {
      stack.push(decl.name);
      spans.push({
        symbolPath: stack.join('.'),
        kind: decl.kind,
        startLine: lineOf(node.getStart(sf)),
        endLine: lineOf(node.getEnd()),
      });
      ts.forEachChild(node, visit);
      stack.pop();
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return spans;
}

/**
 * The innermost (most specific) symbol whose range contains `line` (1-based),
 * or null if the line sits outside any named declaration. Used at capture time
 * to map a changed line to its enclosing symbol.
 */
export function enclosingSymbol(
  source: string,
  line: number,
  fileName = 'file.ts',
): string | null {
  let best: SymbolSpan | null = null;
  for (const s of listSymbols(source, fileName)) {
    if (line < s.startLine || line > s.endLine) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
      best = s;
    }
  }
  return best ? best.symbolPath : null;
}

/** Whether a symbol path still exists in the given source (drift check). */
export function symbolExists(
  source: string,
  symbolPath: string,
  fileName = 'file.ts',
): boolean {
  return listSymbols(source, fileName).some((s) => s.symbolPath === symbolPath);
}
