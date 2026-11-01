/**
 * No runtime import cycle under src/. A cycle in emitted CommonJS means
 * one module of it runs against a half-initialised other: a class or
 * schema that reads as `undefined` at load time depending on which file
 * was required first. source-plane.schema.ts carried a comment explaining
 * the export order that kept its cycle working. The graph is acyclic now,
 * and this keeps it that way.
 *
 * Only edges that survive compilation count: `import type`, and named
 * imports that are all `type`, are erased and cannot form a runtime cycle.
 * Imports used only as types but not marked `type` are counted on purpose:
 * mark them, as the gate's failure message says.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const SRC = resolve(__dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

const FILES = new Set(walk(SRC));

function resolveSpecifier(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(from), spec);
  return [`${base}.ts`, join(base, 'index.ts')].find((c) => FILES.has(c));
}

/** True when the declaration leaves nothing behind in the emitted JS. */
function erased(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // `import './x'` runs x
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      !clause.name &&
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((e) => e.isTypeOnly)
    );
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    !!clause &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((e) => e.isTypeOnly)
  );
}

function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const out: string[] = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const spec = node.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec) || erased(node)) continue;
    const target = resolveSpecifier(file, spec.text);
    if (target) out.push(target);
  }
  return out;
}

/** Strongly connected components with more than one file (Tarjan). */
function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
  return found;
}

describe('import graph', () => {
  it('src/ has no runtime import cycle', () => {
    const graph = new Map([...FILES].map((f) => [f, runtimeImports(f)]));
    const found = cycles(graph).map((c) => c.map((f) => relative(SRC, f)));
    // A failure lists each cycle. Break it by moving what both sides need
    // into a leaf module (see src/common/env-flag.ts, src/db/run-transaction.ts),
    // or mark an import used only as a type with `import type`.
    expect(found).toEqual([]);
  });

  it('the detector sees a cycle, and ignores a type-only edge', () => {
    const a = join(SRC, '__a.ts');
    const b = join(SRC, '__b.ts');
    expect(
      cycles(
        new Map([
          [a, [b]],
          [b, [a]],
        ]),
      ),
    ).toEqual([[a, b].sort()]);
    expect(
      cycles(
        new Map([
          [a, [b]],
          [b, []],
        ]),
      ),
    ).toEqual([]);
    const typeOnly = ts.createSourceFile(
      'x.ts',
      "import type { A } from './a';\nimport { type B } from './b';\nimport { C } from './c';",
      ts.ScriptTarget.Latest,
    );
    const kept = typeOnly.statements.filter(
      (s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && !erased(s),
    );
    expect(kept.map((s) => (s.moduleSpecifier as ts.StringLiteral).text)).toEqual(['./c']);
  });
});
