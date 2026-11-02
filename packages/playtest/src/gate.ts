// The playtest's server-side gate (roadmap G8): every request to the deployed
// build passes through it (a Cloudflare Pages Function, functions/_middleware.ts).
// Without a valid pass cookie it answers with a small form asking for the
// playtest password and the tester's email; a right password stores the email
// (Workers KV, binding TESTERS) and sets the pass cookie, signed with HMAC-SHA256
// so it cannot be forged without GATE_SECRET.
//
// Plain Web APIs only (Request, Response, crypto.subtle), so the same code runs
// in Cloudflare's runtime and in Node 22 for the tests. It is a gate for a
// friends-and-family playtest, not account security: one shared password, no
// rate limit (Cloudflare's own bot protection sits in front), and the password
// never ships in the bundle or the repo (a Pages secret, GATE_PASSWORD).

/** The KV calls the gate makes: Cloudflare's KVNamespace has them, and a Map stands in for tests. */
export interface TesterStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
}

export interface GateEnv {
  /** The playtest password (a Pages secret). */
  GATE_PASSWORD?: string;
  /** The cookie signing key (a Pages secret: 32+ random bytes, base64 or hex). */
  GATE_SECRET?: string;
  /** Where testers' emails go (a KV namespace binding). */
  TESTERS?: TesterStore;
}

/** The pass cookie's name, the form's POST path and how long a pass lasts. */
export const COOKIE = 'tb_pass';
export const GATE_PATH = '/__gate';
export const PASS_DAYS = 30;

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** a === b in time that depends only on their lengths (password and signature checks). */
export function sameText(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

/** A pass for `email` until `expires` (ms since epoch): base64url(email).expires.signature. */
export async function makePass(secret: string, email: string, expires: number): Promise<string> {
  const body = `${b64url(enc.encode(email))}.${expires}`;
  return `${body}.${await hmac(secret, body)}`;
}

/** The email a pass was issued to, or null when it is malformed, forged or expired at `now`. */
export async function readPass(secret: string, pass: string, now: number): Promise<string | null> {
  const parts = pass.split('.');
  if (parts.length !== 3) return null;
  const [email64, exp, sig] = parts as [string, string, string];
  if (!/^\d+$/.test(exp) || Number(exp) <= now) return null;
  if (!sameText(sig, await hmac(secret, `${email64}.${exp}`))) return null;
  try { return new TextDecoder().decode(Uint8Array.from(fromB64url(email64), (c) => c.charCodeAt(0))); } catch { return null; }
}

/** Cookie value by name from a Cookie header. */
export function cookieOf(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** A plausible email: something@something.tld, no spaces, at most 254 characters. */
export const isEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Where to go after the gate: a same-site path (with its query), else "/". Refuses //host and schemes. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The gate's page: the form, with an error line when the last try failed. */
export function gatePage(next: string, error = '', email = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keystone playtest</title>
<meta name="robots" content="noindex, nofollow">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(ellipse at 50% 30%, #2b3242, #11141c); color: #e8ebf2; font: 15px/1.5 system-ui, sans-serif; }
  form { width: min(360px, calc(100vw - 32px)); padding: 28px 24px; border-radius: 14px; background: rgba(17, 20, 28, 0.85); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4); }
  h1 { margin: 0; font: 900 34px/1.1 system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; }
  .tag { margin: 4px 0 18px; color: #f7b955; font-weight: 600; }
  label { display: block; margin: 12px 0 4px; color: #9aa3b8; font-size: 13px; }
  input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #3a4459; border-radius: 8px; background: #1b2030; color: inherit; font: inherit; }
  button { width: 100%; margin-top: 18px; padding: 11px; border: 0; border-radius: 8px; background: #d8693f; color: #fff; font: 700 16px/1.2 system-ui, sans-serif; cursor: pointer; }
  .err { margin-top: 12px; color: #f0806a; }
  .note { margin-top: 14px; color: #6f7890; font-size: 12px; }
</style></head>
<body><form method="post" action="${GATE_PATH}">
  <h1>Keystone</h1><div class="tag">Private playtest</div>
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
  <label for="password">Playtest password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Enter</button>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
  <div class="note">Your email is kept so we can ask how it went. Needs a WebGPU browser: Chrome or Edge on a desktop.</div>
</form></body></html>`;
}

const html = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...extra } });

/**
 * One request through the gate: `next()` serves the build when the request carries a valid pass; a POST
 * to GATE_PATH checks the form; anything else gets the form (401). A missing secret or password is a
 * misconfigured deploy: it fails closed (503) instead of letting everyone in.
 */
export async function gate(request: Request, env: GateEnv, next: () => Promise<Response>, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  if (!env.GATE_PASSWORD || !env.GATE_SECRET) return html('<p>The playtest gate is not configured (GATE_PASSWORD and GATE_SECRET).</p>', 503);
  const pass = cookieOf(request.headers.get('cookie'), COOKIE);
  const email = pass ? await readPass(env.GATE_SECRET, pass, now) : null;
  if (url.pathname === GATE_PATH && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const f = (k: string) => String(form?.get(k) ?? '').trim();
    const to = safeNext(f('next')), who = f('email').toLowerCase();
    if (!isEmail(who)) return html(gatePage(to, 'That email does not look right.', who), 400);
    if (!sameText(f('password'), env.GATE_PASSWORD)) return html(gatePage(to, 'Wrong password.', who), 401);
    await recordTester(env.TESTERS, who, request, now);
    const value = await makePass(env.GATE_SECRET, who, now + PASS_DAYS * 864e5);
    return new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${value}; Path=/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (email) return next();
  return html(gatePage(safeNext(url.pathname + url.search)), 401);
}

/** The tester's KV record: first and last entry and how many times they entered; the list shows them as metadata. */
export interface TesterRecord { email: string; first: string; last: string; entries: number; agent: string }

/** Record a tester's entry (key tester:<email>). A store that fails never blocks a tester: the pass is still issued. */
export async function recordTester(store: TesterStore | undefined, email: string, request: Request, now: number): Promise<void> {
  if (!store) return;
  try {
    const key = `tester:${email}`, at = new Date(now).toISOString();
    const old = JSON.parse((await store.get(key)) ?? 'null') as TesterRecord | null;
    const rec: TesterRecord = { email, first: old?.first ?? at, last: at, entries: (old?.entries ?? 0) + 1, agent: (request.headers.get('user-agent') ?? '').slice(0, 200) };
    await store.put(key, JSON.stringify(rec), { metadata: { first: rec.first, last: rec.last, entries: rec.entries } });
  } catch { /* the entry still goes ahead */ }
}
