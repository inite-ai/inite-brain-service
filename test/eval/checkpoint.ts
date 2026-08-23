import { promises as fs } from 'node:fs';

/**
 * JSONL checkpointing for long paid eval runs (full LongMemEval = 500
 * questions, BEAM 1M tier = 35 huge ingests): every finished score is
 * appended immediately, so a quota death or OOM mid-run costs nothing —
 * rerunning with the same --resume path skips completed question ids and
 * folds their scores into the final report.
 */

export async function loadCheckpoint<T>(
  path: string | undefined,
  key: (row: T) => string,
): Promise<Map<string, T>> {
  const done = new Map<string, T>();
  if (!path) return done;
  let text: string;
  try {
    text = await fs.readFile(path, 'utf-8');
  } catch {
    return done; // first run — nothing checkpointed yet
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as T;
    done.set(key(row), row);
  }
  return done;
}

export async function appendCheckpoint(path: string | undefined, row: unknown): Promise<void> {
  if (!path) return;
  await fs.appendFile(path, `${JSON.stringify(row)}\n`);
}
