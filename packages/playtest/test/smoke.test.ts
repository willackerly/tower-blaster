// pnpm playtest:smoke against the real gate handler (Node's Web APIs, as in
// gate.test.ts): a healthy deploy passes; a stale build, a wrong password, a gate
// that lets everyone in, a misconfigured gate and a page without its isolation
// headers each fail with their own reason.
import { describe, expect, it } from 'vitest';
import { gate, type GateEnv, type TesterStore } from '../src/gate.ts';
import { SMOKE_EMAIL, smoke } from '../src/smoke.ts';

const COMMIT = 'c0ffee'.repeat(6) + 'abcd';
const kv = (): TesterStore & { keys: string[] } => {
  const keys: string[] = [];
  return { keys, get: async () => null, put: async (k) => void keys.push(k) };
};
const env = (over: Partial<GateEnv> = {}): GateEnv => ({ GATE_PASSWORD: 'open sesame', GATE_SECRET: 'k'.repeat(32), TESTERS: kv(), ...over });

/** A fetch that answers like the deployed site: the gate in front of a build whose build.json names `commit`. */
const ISOLATED = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
const site = (e: GateEnv, commit = COMMIT, headers: Record<string, string> = ISOLATED) => (input: string, init?: RequestInit) =>
  gate(new Request(input, init), e, () => Promise.resolve(new URL(input).pathname === '/build.json' ? Response.json({ commit, dirty: false }) : new Response('<div id="door"></div>', { headers })));

describe('playtest smoke', () => {
  it('passes on a healthy deploy of the expected commit, signing in as the smoke address', async () => {
    const e = env();
    expect(await smoke('https://playtest.example', 'open sesame', COMMIT, site(e))).toEqual([]);
    expect((e.TESTERS as ReturnType<typeof kv>).keys).toEqual([`tester:${SMOKE_EMAIL}`]);
  });
  it('fails when build.json names another commit (the deploy has not landed)', async () => {
    expect(await smoke('https://playtest.example', 'open sesame', COMMIT, site(env(), 'old'))).toEqual([`build.json names old, expected ${COMMIT}`]);
  });
  it('fails on a wrong password', async () => {
    expect((await smoke('https://playtest.example', 'nope', COMMIT, site(env())))[0]).toMatch(/^POST \/__gate: 401/);
  });
  it('fails when the site has no gate in front', async () => {
    const open = () => Promise.resolve(Response.json({ commit: COMMIT }));
    expect((await smoke('https://playtest.example', 'open sesame', COMMIT, open))[0]).toMatch(/^GET \/ without a pass: 200/);
  });
  it('fails on a misconfigured gate (no secret)', async () => {
    expect((await smoke('https://playtest.example', 'open sesame', COMMIT, site(env({ GATE_SECRET: '' }))))[0]).toMatch(/: 503/);
  });
  it('fails when the game page comes without its isolation headers', async () => {
    expect((await smoke('https://playtest.example', 'open sesame', COMMIT, site(env(), COMMIT, {})))[0]).toMatch(/isolation headers COOP null, COEP null/);
  });
});
