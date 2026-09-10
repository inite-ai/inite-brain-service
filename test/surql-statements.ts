/**
 * Minimal SurrealQL statement splitter for the migration doctrine gates.
 *
 * Splitting on `;` alone is wrong: DEFINE FUNCTION / DEFINE EVENT bodies
 * carry their own semicolons inside `{ ... }`, and string literals can
 * carry anything. So comments and literals are blanked out first
 * (keeping offsets stable) and the split then only fires on a `;` at
 * bracket depth zero. `masked` is the comment/literal-free text to make
 * assertions against; `raw` is the original slice for error messages.
 */

export interface SurqlStatement {
  raw: string;
  masked: string;
}

/** Blank out line comments, block comments and quoted literals, length-preserving. */
export function maskNoise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < sql.length && sql[i] !== quote) {
        if (sql[i] === '\\') {
          out += ' ';
          i++;
        }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Top-level statements of one migration file. */
export function splitStatements(sql: string): SurqlStatement[] {
  const masked = maskNoise(sql);
  const found: SurqlStatement[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const stmt = { raw: sql.slice(start, end).trim(), masked: masked.slice(start, end).trim() };
    if (stmt.masked.length > 0) found.push(stmt);
  };
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth <= 0) {
      push(i);
      start = i + 1;
    }
  }
  push(masked.length);
  return found;
}

/** First keyword of a statement, upper-cased. */
export function leadingKeyword(stmt: SurqlStatement): string {
  return (stmt.masked.trim().split(/\s+/)[0] ?? '').toUpperCase();
}

/** Collapse whitespace so a statement fits on one assertion-message line. */
export function oneLine(stmt: SurqlStatement): string {
  return stmt.masked.replace(/\s+/g, ' ').trim();
}
