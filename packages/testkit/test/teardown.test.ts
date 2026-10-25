import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeWithin, parseLsofSockets, releaseStdioOnExit, stdioHoldersOf } from '../src/index.ts';

const never = () => new Promise<void>(() => {});
const after = (ms: number, fail = false) => () => new Promise<void>((resolve, reject) => setTimeout(() => (fail ? reject(new Error('late failure')) : resolve()), ms));

describe('closeWithin', () => {
  it('runs every step in order and reports none stuck when all finish in time', async () => {
    const order: string[] = [], log: string[] = [];
    const stuck = await closeWithin([['a', async () => { order.push('a'); }], ['b', async () => { order.push('b'); }]], 200, (l) => log.push(l));
    expect(stuck).toEqual([]);
    expect(order).toEqual(['a', 'b']);
    expect(log).toEqual([]);
  });

  it('gives up on a step that never finishes, after its timeout, and still runs the next one', async () => {
    const log: string[] = [];
    let ranNext = false;
    const t0 = performance.now();
    const stuck = await closeWithin([['browser', never], ['server', async () => { ranNext = true; }]], 100, (l) => log.push(l));
    const ms = performance.now() - t0;
    expect(stuck).toEqual(['browser']);
    expect(ranNext).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(95);
    expect(ms).toBeLessThan(1000);
    expect(log).toEqual(['browser did not close within 0.1 s; leaving it']);
  });

  it('logs a step that fails in time and counts it as finished', async () => {
    const log: string[] = [];
    const stuck = await closeWithin([['browser', async () => { throw new Error('boom'); }], ['server', async () => {}]], 100, (l) => log.push(l));
    expect(stuck).toEqual([]);
    expect(log).toEqual(['browser failed to close: boom']);
  });

  it('logs, and does not throw, when a step it gave up on later finishes or fails', async () => {
    // A rejection after the timeout must not become an unhandled rejection (vitest fails the run on one).
    const log: string[] = [];
    const stuck = await closeWithin([['slow', after(150)], ['failing', after(150, true)]], 50, (l) => log.push(l));
    expect(stuck).toEqual(['slow', 'failing']);
    await new Promise((r) => setTimeout(r, 300));
    expect(log).toEqual([
      'slow did not close within 0.05 s; leaving it',
      'failing did not close within 0.05 s; leaving it',
      expect.stringMatching(/^slow closed after 0\.\d s$/),
      'failing failed to close (after its timeout): late failure',
    ]);
  });
});

// lsof -nP rows captured on Will's M5 Max (2026-10-25 22:30) while a bench
// hung: node's fd 30 is the browser's stderr, and the orphaned crash handler
// 83730 holds the other end. 48552 is a handler with its stdio on /dev/null.
const NODE_LSOF = `COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    83727 will    0u    unix 0x5a7dbf45aa21ca6a      0t0                     ->(none)
node    83727 will    4     PIPE 0xb394436148afaa37    16384                     ->0x939648e22f8139d0
node    83727 will   12u    unix 0xf9e08779989b4145      0t0                     ->0x3961ff109bec9128
node    83727 will   30u    unix  0x473109ff403ce37      0t0                     ->0x758500adf282fb4d`;
const CRASHPAD_LSOF = `COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF                NODE NAME
chrome_cr 83730 will    0r   CHR                3,2      0t0                 336 /dev/null
chrome_cr 83730 will    1w   CHR                3,2      0t0                 336 /dev/null
chrome_cr 83730 will    2u  unix 0x758500adf282fb4d      0t0                     ->0x473109ff403ce37
chrome_cr 48552 will    1w   CHR                3,2      0t0                 336 /dev/null
chrome_cr 48552 will    2u   CHR                3,2 0t202196                 336 /dev/null
chrome_cr 51000 will    2u  unix 0x1111111111111111      0t0                     ->0x2222222222222222
chrome_cr 52000 will    5u  unix 0x3333333333333333      0t0                     ->0x473109ff403ce37`;

describe('crash handlers holding our stdio (macOS lsof)', () => {
  it('parses the unix-socket rows of lsof', () => {
    expect(parseLsofSockets(NODE_LSOF)).toEqual([
      { command: 'node', pid: 83727, fd: 0, addr: '0x5a7dbf45aa21ca6a', peer: null },
      { command: 'node', pid: 83727, fd: 12, addr: '0xf9e08779989b4145', peer: '0x3961ff109bec9128' },
      { command: 'node', pid: 83727, fd: 30, addr: '0x473109ff403ce37', peer: '0x758500adf282fb4d' },
    ]);
  });

  it('finds only the handler whose stdout or stderr is the far end of our socket', () => {
    const own = parseLsofSockets(NODE_LSOF), others = parseLsofSockets(CRASHPAD_LSOF);
    // Not 48552 (/dev/null), 51000 (someone else's socket) or 52000 (fd 5, not its stdio).
    expect(stdioHoldersOf(own, others)).toEqual([83730]);
    expect(stdioHoldersOf(own.filter((s) => s.fd !== 30), others)).toEqual([]);
  });
});

describe('releaseStdioOnExit', () => {
  // sh exits at once; the sleep it leaves behind holds its stdout and stderr,
  // as Chrome's crash handler holds the browser's.
  const spawnHeld = () => {
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const holder = new Promise<number>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
    const closed = new Promise<number>((resolve) => child.once('close', () => resolve(performance.now())));
    const exited = new Promise<number>((resolve) => child.once('exit', () => resolve(performance.now())));
    // A zombie counts as gone: the orphaned sleep's reaper may be slow (or absent, as PID 1 in a container).
    const zombie = (pid: number) => { try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
    const alive = (pid: number) => { try { process.kill(pid, 0); return !zombie(pid); } catch { return false; } };
    const cleanup = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group gone */ } };
    return { child, holder, closed, exited, alive, cleanup };
  };
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

  it('without it, the child never closes while another process holds its output (the control)', async () => {
    const h = spawnHeld();
    try {
      await h.exited;
      expect(await within(h.closed, 1000)).toBe('timeout');
    } finally {
      h.cleanup();
    }
  });

  it('closes our end of a held stdout and stderr after the grace period', async () => {
    const h = spawnHeld(), log: string[] = [];
    releaseStdioOnExit(h.child, { graceMs: 100, log: (l) => log.push(l), findHolders: () => [] });
    try {
      const exited = await h.exited;
      const closed = await within(h.closed, 2000);
      expect(closed).not.toBe('timeout');
      expect((closed as number) - exited).toBeGreaterThanOrEqual(95);
      expect(log).toEqual(['the browser exited, but its stdio was still held open; closing our end']);
      expect(h.alive(await h.holder)).toBe(true); // nothing named it, so nothing was stopped
    } finally {
      h.cleanup();
    }
  });

  it('stops the holders that findHolders names, given our fds of the held streams', async () => {
    const h = spawnHeld(), log: string[] = [];
    const pid = await h.holder;
    let asked: number[] = [];
    releaseStdioOnExit(h.child, { graceMs: 100, log: (l) => log.push(l), findHolders: (fds) => { asked = fds; return [pid]; } });
    try {
      await h.exited;
      expect(await within(h.closed, 2000)).not.toBe('timeout');
      expect(asked).toHaveLength(2);
      expect(asked.every((fd) => Number.isInteger(fd) && fd > 2)).toBe(true);
      expect(log).toEqual([`the browser exited, but its stdio was still held open by pid ${pid}, now stopped; closing our end`]);
      for (let i = 0; i < 40 && h.alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
      expect(h.alive(pid)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('does nothing when the output closes with the child', async () => {
    const child = spawn('sh', ['-c', 'echo done'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log: string[] = [];
    let asked = false;
    releaseStdioOnExit(child, { graceMs: 50, log: (l) => log.push(l), findHolders: () => { asked = true; return []; } });
    child.stdout.resume();
    await new Promise((r) => child.once('close', r));
    await new Promise((r) => setTimeout(r, 150));
    expect(asked).toBe(false);
    expect(log).toEqual([]);
  });
});
