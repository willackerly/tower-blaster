// Cloudflare Pages runs this before every request to the playtest build (static
// assets included): the gate (../src/gate.ts) lets a request with a valid pass
// through to the build and answers everything else with the password form.
// Bindings: GATE_PASSWORD and GATE_SECRET (Pages secrets), TESTERS (KV), set by
// `pnpm playtest:deploy` (src/deploy.ts).
import { gate, type GateEnv } from '../src/gate.ts';

interface PagesContext { request: Request; env: GateEnv; next(): Promise<Response> }

export const onRequest = (ctx: PagesContext): Promise<Response> => gate(ctx.request, ctx.env, () => ctx.next());
