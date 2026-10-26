// Bounded teardown for scripts that drive a browser. On Will's M5 Max an
// avbd-gpu bench suite twice stalled after its last case (2026-10-25) and
// never wrote its summary. Playwright's browser.close() (playwright-core
// 1.63) asks Chrome to close, SIGKILLs its process group after 30 s, and then
// waits, with no limit, for the child's 'close' event, which needs every
// process holding Chrome's stdout/stderr to exit. Chrome's crash handler
// (chrome_crashpad_handler) holds them from outside that process group, and a
// GPU helper stuck in the driver may not die, so that wait can be forever.
// Confirmed on the Mac (2026-10-25 22:30): the browser had exited, its crash
// handler (ppid 1, its own group) held the browser's stderr socket, and
// killing it let the bench finish within 1 s. Chrome on macOS always starts
// the handler (no switch turns it off there), and it outlives the browser.
// launchChromium (index.ts) releases the browser's stdio once it has exited
// (releaseStdioOnExit); closeWithin bounds whatever still hangs.
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * How long each teardown step may take before closeWithin gives up on it:
 * past Playwright's own 30 s kill, after which a browser that ignored the
 * close request has exited and releaseStdioOnExit lets the close finish.
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

/** How long after the browser exits its stdio pipes may stay open before releaseStdioOnExit closes them. */
export const STDIO_GRACE_MS = 1000;

export interface ReleaseOptions {
  graceMs?: number;
  log?: (line: string) => void;
  /** Pids of the processes to stop that hold the far end of these fds of ours (default: crashHandlersHolding on macOS, none elsewhere). */
  findHolders?: (fds: number[]) => number[];
}

/**
 * Once proc has exited, give its stdio pipes (stdout, stderr and Playwright's
 * CDP pipes) graceMs to close. Node emits the child's 'close', which
 * Playwright's close waits for, only when all of them have. If some have
 * not, stop the processes findHolders names (Chrome's crash handler on macOS,
 * which would otherwise live on) and close our ends.
 */
export function releaseStdioOnExit(proc: ChildProcess, opts: ReleaseOptions = {}): void {
  const { graceMs = STDIO_GRACE_MS, log = (line: string) => console.error(line) } = opts;
  const findHolders = opts.findHolders ?? (process.platform === 'darwin' ? crashHandlersHolding : () => []);
  proc.once('exit', () => {
    const timer = setTimeout(() => {
      const open = proc.stdio.slice(1).filter((s): s is Readable | Writable => !!s && !s.destroyed);
      if (!open.length) return;
      const fds = open.map((s) => (s as unknown as { _handle?: { fd?: number } })._handle?.fd).filter((fd): fd is number => typeof fd === 'number' && fd >= 0);
      let stopped: number[] = [];
      try {
        stopped = fds.length ? findHolders(fds) : [];
      } catch (e) {
        log(`could not look for the processes holding the browser's stdio: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const pid of stopped) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      log(`the browser exited, but its stdio was still held open${stopped.length ? ` by pid ${stopped.join(', ')}, now stopped` : ''}; closing our end`);
      for (const s of open) s.destroy();
    }, graceMs);
    timer.unref();
  });
}

/** A unix-socket row of lsof's default output. */
export interface LsofSocket { command: string; pid: number; fd: number; addr: string; peer: string | null }

/**
 * The unix-socket rows of lsof's default output (COMMAND PID USER FD TYPE
 * DEVICE SIZE/OFF NODE NAME). On macOS DEVICE is the socket's address and
 * NAME its peer's, as ->0x...
 */
export function parseLsofSockets(text: string): LsofSocket[] {
  const rows: LsofSocket[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 7 || t[4] !== 'unix' || !/^\d+$/.test(t[1]!) || !/^\d+/.test(t[3]!)) continue;
    const name = t[t.length - 1]!;
    rows.push({ command: t[0]!, pid: Number(t[1]), fd: parseInt(t[3]!, 10), addr: t[5]!, peer: name.startsWith('->0x') ? name.slice(2) : null });
  }
  return rows;
}

/** The pids in `others` whose stdout or stderr is the far end of one of the sockets in `own`. */
export function stdioHoldersOf(own: LsofSocket[], others: LsofSocket[]): number[] {
  const mine = new Set(own.map((s) => s.addr));
  return [...new Set(others.filter((s) => (s.fd === 1 || s.fd === 2) && s.peer !== null && mine.has(s.peer)).map((s) => s.pid))];
}

/**
 * macOS: the Chrome crash handlers whose stdout or stderr is the far end of
 * one of these fds of this process. Only those: the handler of Will's own
 * Chrome has its stdio on /dev/null, and another browser of ours has its own
 * sockets.
 */
export function crashHandlersHolding(fds: number[]): number[] {
  const lsof = (args: string[]) => {
    const r = spawnSync('lsof', ['-nP', '-a', '-U', ...args], { encoding: 'utf8', timeout: 5000 });
    if (r.error) throw r.error;
    return parseLsofSockets(r.stdout ?? ''); // lsof exits 1 when nothing matches
  };
  return stdioHoldersOf(lsof(['-p', String(process.pid), '-d', fds.join(',')]), lsof(['-c', 'chrome_crashpad', '-d', '1,2']));
}
