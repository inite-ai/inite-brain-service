/**
 * Test fixture for JobWorkerPool — pretends to be a CPU-bound handler
 * module. The pool dynamic-imports this from a worker thread, calls
 * `run(input)`, and posts the result back to the main thread.
 */
export async function run(input: unknown): Promise<unknown> {
  const i = input as { mode?: string; payload?: unknown };
  if (i.mode === 'boom') {
    throw new Error('worker boom for test');
  }
  if (i.mode === 'sleep') {
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    echoed: i.payload ?? null,
    workerPid: process.pid,
  };
}
