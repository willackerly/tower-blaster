// Bounded teardown for scripts that drive a browser. On Will's M5 Max an
// avbd-gpu bench suite twice stalled after its last case (2026-10-25) and
// never wrote its summary. Playwright's browser.close() (playwright-core
// 1.63) asks Chrome to close, SIGKILLs its process group after 30 s, and then
// waits, with no limit, for the child's 'close' event, which needs every
// process holding Chrome's stdout/stderr to exit. Chrome's crash handler
// (chrome_crashpad_handler) holds them from outside that process group, and a
// GPU helper stuck in the driver may not die, so that wait can be forever.
// Confirmed on the Mac (2026-10-25 22:30): the browser had exited, and its
// crash handler (ppid 1, its own group) still held the browser's stderr.

/**
 * How long each teardown step may take before closeWithin gives up on it:
 * past Playwright's own 30 s kill, so a helper that SIGKILL frees still
 * closes normally.
 */
export const CLOSE_TIMEOUT_MS = 45_000;

/**
 * Run teardown steps in order, giving each at most `ms`. Resolves to the
 * names of the steps that had not finished in time; those keep running in the
 * background, and if one fails later its error is logged, not thrown. A step
 * that fails in time is logged and counts as finished, so the steps after it
 * still run.
 */
export async function closeWithin(
  steps: ReadonlyArray<readonly [name: string, step: () => Promise<unknown>]>,
  ms = CLOSE_TIMEOUT_MS,
  log: (line: string) => void = (line) => console.error(line),
): Promise<string[]> {
  const stuck: string[] = [];
  for (const [name, step] of steps) {
    const t0 = performance.now();
    let late = false;
    const done = Promise.resolve()
      .then(step)
      .then(
        () => { if (late) log(`${name} closed after ${((performance.now() - t0) / 1000).toFixed(1)} s`); },
        (e: unknown) => log(`${name} failed to close${late ? ' (after its timeout)' : ''}: ${e instanceof Error ? e.message : String(e)}`),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
    const outcome = await Promise.race([done, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      late = true;
      stuck.push(name);
      log(`${name} did not close within ${ms / 1000} s; leaving it`);
    }
  }
  return stuck;
}

/**
 * Flush stdout and stderr, then exit. For a CLI whose teardown left a step
 * running (closeWithin), which keeps Node's event loop alive. Playwright's
 * exit handler kills the browser's process group only until its own 30 s
 * kill has run; after that nothing more is killed at exit, and its temporary
 * profile directory is left behind.
 */
export async function exitNow(code = Number(process.exitCode ?? 0)): Promise<never> {
  for (const s of [process.stdout, process.stderr]) await new Promise<void>((resolve) => s.write('', () => resolve()));
  process.exit(code);
}
