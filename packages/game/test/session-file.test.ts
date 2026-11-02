// Save session (roadmap G8): the file and its replay link; the WebGPU-missing message.
import { describe, expect, it } from 'vitest';
import { L1, readShots, type LevelScore, type Shot } from '@tb/keystone';
import { bankAfterLine, replayUrl, SESSION_KIND, sessionFile, sessionFileName } from '../src/session-file.ts';
import { webgpuMissing } from '../src/support.ts';
import { resultHtml } from '../src/hud.ts';

const shots = L1.solutions!.par as Shot[];
const score: LevelScore = { lines: [{ label: 'Par', value: 300 }], total: 300, stars: 2, stamp: 'PAR', leverage: 1.5 };
const facts = { level: 'L1', hash: 'abc', custom: false, engine: 'gpu', adapter: 'apple metal-3', shots, banked: false, score, build: 'deadbeef' };

describe('session file', () => {
  it('holds the level, the line, the engine and the score, and a link that replays it', () => {
    const f = sessionFile(facts, 'https://playtest.example/?look=real&door=1#x', new Date('2026-11-02T03:04:05Z'));
    expect(f).toMatchObject({ kind: SESSION_KIND, version: 1, level: 'L1', hash: 'abc', engine: 'gpu', adapter: 'apple metal-3', banked: false, build: 'deadbeef', savedAt: '2026-11-02T03:04:05.000Z', score });
    expect(readShots(f.shots)).toEqual(shots);
    const u = new URL(f.replay);
    expect(Object.fromEntries(u.searchParams)).toEqual({ look: 'real', level: 'L1', 'keystone.shots': f.shots });
    expect(u.hash).toBe('');
    expect(sessionFileName(f)).toBe('keystone-L1-2026-11-02T03-04-05.json');
  });
  it('a round that banked replays with a bank after the line', () => {
    expect(new URL(replayUrl('https://x.example/?keystone.bank=1', { ...facts, banked: false })).searchParams.has('keystone.bank')).toBe(false);
    expect(new URL(replayUrl('https://x.example/', { ...facts, banked: true })).searchParams.get('keystone.bank')).toBe('1');
  });
  it('refuses a session with no shots', () => {
    expect(() => sessionFile({ ...facts, shots: [] }, 'https://x.example/')).toThrow(/no shots/);
  });
  it('keystone.bank is 0 or 1', () => {
    expect(bankAfterLine(new URLSearchParams(''))).toBe(false);
    expect(bankAfterLine(new URLSearchParams('keystone.bank=1'))).toBe(true);
    expect(() => bankAfterLine(new URLSearchParams('keystone.bank=yes'))).toThrow(/keystone.bank must be 0 or 1/);
  });
  it('the result card offers Save session only with a score and a page that saves', () => {
    expect(resultHtml(L1, score, 2, true, true)).toContain('data-act="save"');
    expect(resultHtml(L1, score, 2, true)).not.toContain('data-act="save"');
    expect(resultHtml(L1, null, 2, true, true)).not.toContain('data-act="save"');
  });
});

describe('WebGPU missing', () => {
  it('tells a missing WebGPU from other errors', () => {
    expect(webgpuMissing('WebGPU unavailable (navigator.gpu missing; needs a secure context)')).toBe(true);
    expect(webgpuMissing('no WebGPU adapter')).toBe(true);
    expect(webgpuMissing('GPU device lost: x')).toBe(false);
  });
});
