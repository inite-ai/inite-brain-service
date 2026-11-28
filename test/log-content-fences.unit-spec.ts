/**
 * Ground rule 6: logs carry ids and counts, never memory content. These
 * log lines printed fact values (dreams corroborate), the user's question
 * (relearn), person and entity names (entity resolution / upsert) and the
 * chat router's raw model output. The scan reads every logger call in
 * those files and fails on the interpolations that put content in a line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'src/dreams/corroborate.service.ts',
  'src/dreams/resolver.service.ts',
  'src/documents/relearn-from-raw.service.ts',
  'src/ingest/entity-resolver.service.ts',
  'src/ingest/entity-upsert.service.ts',
  'src/admin/chat-router-llm.service.ts',
];

/** Interpolations that put memory content into a log line. */
const CONTENT = [
  /\$\{[^}]*\.object\}/,
  /\$\{name\}/,
  /\$\{e\.name\}/,
  /\$\{[^}]*canonicalName[^}]*\}/,
  /\$\{[^}]*question[^}]*\}/,
  /\$\{[^}]*skeleton[^}]*\}/,
  /\$\{content(?!\.length\})[^}]*\}/,
];

/** Every `this.logger.<level>(...)` / `logger.<level>(...)` call, balanced on parentheses. */
function loggerCalls(src: string): string[] {
  const out: string[] = [];
  const re = /logger\.(log|warn|error|debug|verbose)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, end + 1));
  }
  return out;
}

describe('no memory content in these log lines', () => {
  it.each(FILES)('%s', (file) => {
    const calls = loggerCalls(readFileSync(join(__dirname, '..', file), 'utf8'));
    expect(calls.length).toBeGreaterThan(0);
    const offenders = calls.filter((c) => CONTENT.some((re) => re.test(c)));
    expect(offenders).toEqual([]);
  });
});
