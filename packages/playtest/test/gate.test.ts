// The playtest gate (roadmap G8) on Node's own Request, Response and WebCrypto,
// the Web APIs Cloudflare's runtime has: form on any path without a pass, the
// password and email checked, the tester recorded, a signed pass that cannot be
// forged, tampered with or used after it expires, and a misconfigured deploy
// that fails closed.
import { describe, expect, it } from 'vitest';
import { COOKIE, cookieOf, gate, GATE_PATH, type GateEnv, isEmail, makePass, PASS_DAYS, readPass, safeNext, sameText, type TesterStore } from '../src/gate.ts';

const NOW = Date.UTC(2026, 10, 2);
const SECRET = 'k'.repeat(32);

function kv(): TesterStore & { m: Map<string, { value: string; metadata?: unknown }> } {
  const m = new Map<string, { value: string; metadata?: unknown }>();
  return { m, get: async (k) => m.get(k)?.value ?? null, put: async (k, value, o) => void m.set(k, { value, metadata: o?.metadata }) };
}
const env = (over: Partial<GateEnv> = {}): GateEnv => ({ GATE_PASSWORD: 'open sesame', GATE_SECRET: SECRET, TESTERS: kv(), ...over });
const served = () => Promise.resolve(new Response('the game', { status: 200 }));
const get = (path: string, cookie?: string) => new Request(`https://playtest.example${path}`, { headers: cookie ? { cookie } : {} });
const post = (fields: Record<string, string>) => new Request(`https://playtest.example${GATE_PATH}`, { method: 'POST', body: new URLSearchParams(fields), headers: { 'user-agent': 'test-agent' } });
const passFrom = (r: Response) => cookieOf(r.headers.get('set-cookie'), COOKIE);

describe('gate', () => {
  it('serves the form (401, not indexed, not cached) on any path without a pass, remembering where the tester was going', async () => {
    const r = await gate(get('/?level=B3'), env(), served, NOW);
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    const body = await r.text();
    expect(body).toContain(`action="${GATE_PATH}"`);
    expect(body).toContain('name="next" value="/?level=B3"');
    expect(body).not.toContain('open sesame');
  });
  it('a right password and email: records the tester, sets a signed HttpOnly pass and goes on to `next`', async () => {
    const e = env(), store = e.TESTERS as ReturnType<typeof kv>;
    const r = await gate(post({ email: ' Tester@Example.com ', password: 'open sesame', next: '/?level=B3' }), e, served, NOW);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/?level=B3');
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toContain(`Max-Age=${PASS_DAYS * 86400}`);
    const rec = JSON.parse(store.m.get('tester:tester@example.com')!.value);
    expect(rec).toMatchObject({ email: 'tester@example.com', entries: 1, agent: 'test-agent', first: new Date(NOW).toISOString() });
    expect(store.m.get('tester:tester@example.com')!.metadata).toEqual({ first: rec.first, last: rec.last, entries: 1 });
    // The pass now lets every request through.
    const ok = await gate(get('/assets/index.js', `other=1; ${COOKIE}=${passFrom(r)}`), e, served, NOW + 1000);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('the game');
  });
  it('counts a tester\'s entries and keeps their first visit', async () => {
    const e = env(), store = e.TESTERS as ReturnType<typeof kv>;
    await gate(post({ email: 'a@b.co', password: 'open sesame' }), e, served, NOW);
    await gate(post({ email: 'a@b.co', password: 'open sesame' }), e, served, NOW + 3600e3);
    const rec = JSON.parse(store.m.get('tester:a@b.co')!.value);
    expect(rec).toMatchObject({ entries: 2, first: new Date(NOW).toISOString(), last: new Date(NOW + 3600e3).toISOString() });
  });
  it('a wrong password or a bad email: the form again with the reason, no pass, nothing recorded', async () => {
    const e = env(), store = e.TESTERS as ReturnType<typeof kv>;
    const wrong = await gate(post({ email: 'a@b.co', password: '1338' }), e, served, NOW);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Wrong password.');
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const bad = await gate(post({ email: 'not-an-email', password: 'open sesame' }), e, served, NOW);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('That email does not look right.');
    expect(store.m.size).toBe(0);
  });
  it('a pass that is forged, tampered with, signed with another secret or expired is refused', async () => {
    const good = await makePass(SECRET, 'a@b.co', NOW + 1000);
    const [email64, exp, sig] = good.split('.') as [string, string, string];
    expect(await readPass(SECRET, good, NOW)).toBe('a@b.co');
    expect(await readPass(SECRET, good, NOW + 1000)).toBeNull(); // expired
    expect(await readPass(SECRET, `${email64}.${Number(exp) + 1e9}.${sig}`, NOW)).toBeNull(); // extended
    expect(await readPass(SECRET, `${btoa('x@y.z')}.${exp}.${sig}`, NOW)).toBeNull(); // another email
    expect(await readPass('another secret of 32 characters!', good, NOW)).toBeNull();
    for (const junk of ['', 'a.b', 'a.b.c.d', `${email64}.soon.${sig}`]) expect(await readPass(SECRET, junk, NOW)).toBeNull();
    const r = await gate(get('/', `${COOKIE}=${good}`), env(), served, NOW + 1000);
    expect(r.status).toBe(401);
  });
  it('fails closed when the deploy has no password or secret', async () => {
    for (const e of [env({ GATE_PASSWORD: undefined }), env({ GATE_SECRET: '' })]) {
      const r = await gate(get('/'), e, served, NOW);
      expect(r.status).toBe(503);
    }
  });
  it('a store that fails does not keep a tester out', async () => {
    const broken: TesterStore = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
    const r = await gate(post({ email: 'a@b.co', password: 'open sesame' }), env({ TESTERS: broken }), served, NOW);
    expect(r.status).toBe(303);
  });
  it('escapes what it echoes back', async () => {
    const r = await gate(post({ email: '"><script>@x.y', password: 'nope' }), env(), served, NOW);
    expect(await r.text()).not.toContain('<script>');
  });
});

describe('gate helpers', () => {
  it('safeNext keeps same-site paths only', () => {
    expect(safeNext('/?level=B2')).toBe('/?level=B2');
    for (const bad of [null, '', 'https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)']) expect(safeNext(bad)).toBe('/');
  });
  it('isEmail, sameText, cookieOf', () => {
    expect(isEmail('a@b.co')).toBe(true);
    for (const bad of ['a@b', 'a b@c.d', '@b.co', `${'a'.repeat(250)}@b.co`]) expect(isEmail(bad)).toBe(false);
    expect(sameText('1337', '1337')).toBe(true);
    expect(sameText('1337', '13370')).toBe(false);
    expect(sameText('', 'x')).toBe(false);
    expect(cookieOf('a=1; tb_pass=x.y.z; b=2', 'tb_pass')).toBe('x.y.z');
    expect(cookieOf(null, 'tb_pass')).toBeNull();
  });
});
