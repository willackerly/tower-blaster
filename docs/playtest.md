# Playtest build (roadmap G8)

Status 2026-11-02. Will's choices (roadmap defaults, 2026-11-01): host on Cloudflare Pages (free tier), put a server-side gate in front that asks for the playtest password, and collect each tester's email. The code lives in `packages/playtest`.

## What testers get

1. A link, `https://tower-blaster-playtest.pages.dev` unless the project is renamed.
2. A small form that asks for their email and the playtest password.
3. After that, the game's front door ([game/front-door.md](game/front-door.md)). The pass lasts 30 days in that browser.

Every round's result card has **Save session**. It downloads a JSON file with the level, the shots, the engine and GPU, the score and a replay link. Testers send that file back. On the same kind of machine the link replays the round to the same score.

A browser without WebGPU gets a card saying to use Chrome or Edge on a desktop, not a raw error.

## Commands

| Command | What it does |
|---|---|
| `pnpm playtest:build` | Builds the game page into `packages/playtest/dist`, then adds `_headers` (cross-origin isolation as on the dev server, noindex, year-long caching of hashed assets), `robots.txt` (disallow all) and `build.json` (the commit). |
| `pnpm playtest:local` | Serves that build behind the gate in Cloudflare's own runtime (`wrangler pages dev`, local KV) at http://localhost:8788. The password is `PLAYTEST_PASSWORD`, else `local`. |
| `PLAYTEST_PASSWORD=... pnpm playtest:deploy` | Builds and deploys (see below). |
| `pnpm playtest:testers` | Prints who entered, as CSV: email, first entry, last entry, number of entries. |
| `PLAYTEST_PASSWORD=... pnpm playtest:smoke [commit]` | Checks the live site from outside. Over HTTP: the form answers 401, the password gets a 303 and a pass, the pass opens `build.json`, which must name the commit (default `HEAD`), and the game page arrives with its isolation headers. Then, in headless Chromium: the front door, Play, the level loading, and the pre-aimed first shot, with no page errors. It runs on Rapier, offscreen and with `progress=off`, so it takes about the same time on any machine. The GPU path is covered by the ci suite. `PLAYTEST_SMOKE_BROWSER=0` skips the browser half, and `PLAYTEST_SMOKE_SHOT=file.png` saves a screenshot. Needs no Cloudflare login. |
| `pnpm playtest:agent` | The agent playtest round (G9b, [game/agent-playtest-1.md](game/agent-playtest-1.md)): every level and mode played in headless Chromium on a local Vite server at desktop and phone sizes, with captures, contact sheets and `report.json` written to `agent-playtest-out/` (git-ignored). `--only <regex>`, `--viewport`, `--workers`, `--engine`. |

Wrangler runs through `npx` at a pinned version (`WRANGLER` in `src/deploy.ts`, 4.151.0), so it is not a repo dependency.

## Deploying

The first run needs a Cloudflare login. Run it on a machine with a browser, which in practice means Will's Mac:

```sh
cd ~/dev/tower-blaster && git pull && pnpm install
PLAYTEST_PASSWORD=<the password> pnpm playtest:deploy
```

What `deploy.ts` does, in order. Each step is skipped when an earlier run already did it:

1. Build.
2. Check the Cloudflare login. If there is none, run `wrangler login`, which opens the browser once. `wrangler whoami` exits 0 even when logged out, so the script reads what it prints. Without this check, every later call would stop and ask for `CLOUDFLARE_API_TOKEN`; that happened on the first try, 2026-11-02. A token works instead of the login: set `CLOUDFLARE_API_TOKEN` to a custom token with Account permissions Cloudflare Pages Edit and Workers KV Storage Edit, and User permissions User Details Read and Memberships Read.
3. Create the KV namespace `<project>-testers`, then write `packages/playtest/wrangler.toml` binding it as `TESTERS`. The file is git-ignored.
4. Create the Pages project, with production branch `main`.
5. Set the secrets. `GATE_PASSWORD` is set on every run, so changing the password is just a new run with the new value. `GATE_SECRET` is the cookie signing key: 32 random bytes, set only once, because a new key would sign every tester out.
6. Deploy `dist`, tagged with the commit.

The password is never in the repo or the bundle. It lives only in the Pages secret. Later deploys are the same command.

**Rollback:** in the Cloudflare dashboard, open Workers & Pages, then the project, then Deployments, and pick "Rollback" on an earlier deployment. Alternatively, check out an earlier commit and deploy again.

## How deploys run (decided 2026-11-05)

Deploys run from Will's Mac, with his wrangler login, and there is no Cloudflare token in the repo. The Mac has `~/dev/tb-playtest-deploy.sh`, a local script that is not in the repo because it holds the password. It pulls main in `~/dev/tb-playtest` (a clone kept only for deploys), installs, runs `pnpm playtest:deploy`, then `pnpm playtest:smoke` against the live site. A user-level Claude Code allow rule on the Mac lets a Remote Control session run that one script without a prompt, so Claude can redeploy after a merge. Will chose this over creating an API token.

Alternatives considered: a GitHub Actions deploy after every green ci run (below), which needs a token stored as a repo secret, and Cloudflare Pages' Git integration, which needs a new project and URL and has no smoke step.

## Deploying from GitHub Actions (off)

`.github/workflows/playtest.yml` deploys main and then runs `pnpm playtest:smoke` against the live site, so a deploy that does not serve the new commit behind the gate fails the run. Today it runs only by hand: Actions tab, then Run workflow. To deploy after every green ci run on main instead, restore the `workflow_run` trigger named in the file's header. With that trigger, it checks out the commit ci tested, and it skips a commit that main has already moved past. One deploy runs at a time.

It needs these in the repo's settings (Settings, Secrets and variables, Actions). None are set today. Without them, a run fails at its first step and names what is missing.

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | A custom token with the permissions in step 2 above. Create it in the Cloudflare dashboard under My Profile, API Tokens. |
| `CLOUDFLARE_ACCOUNT_ID` | variable | The account ID that `wrangler whoami` prints. |
| `PLAYTEST_PASSWORD` | secret | The playtest password. Every deploy sets `GATE_PASSWORD` from it, so changing this secret changes the password at the next deploy. |

The smoke check signs in as `ci-smoke@tower-blaster.invalid`. That key shows up in the KV namespace, but `pnpm playtest:testers` leaves it out.

## The gate

`src/gate.ts` is plain Web APIs (Request, Response, WebCrypto), run by `functions/_middleware.ts` in front of every request, static assets included:

- **No valid pass:** the request gets the form with status 401, `no-store` and `noindex`. The form remembers the path the tester asked for.
- **`POST /__gate`:** the gate checks the email's shape and compares the password in constant time. On success it:
  - records `tester:<email>` in KV (first and last entry, entry count, user agent);
  - sets an HttpOnly, Secure, SameSite=Lax cookie `tb_pass`, which holds base64url(email), the expiry and an HMAC-SHA256 signature;
  - redirects to the remembered path, accepting only paths on the same site.
- **Misconfigured deploy** (no password or no secret): the gate answers 503 and lets no one in.
- **KV outage:** it never keeps a tester out. The pass is still issued.

This is a gate for a friends-and-family playtest, not account security. There is one shared password and no rate limit of its own (Cloudflare's edge protection sits in front of it). The emails are not verified.

## Verification

- `packages/playtest/test/gate.test.ts` runs on Node's Web APIs. It covers:
  - the form on any path;
  - the right password, with the tester recorded and the entry count incremented;
  - a wrong password and a bad email;
  - passes that are forged, tampered with, signed with another key, extended or expired;
  - failing closed;
  - a KV outage;
  - escaping;
  - `next` accepting same-site paths only.
- `packages/playtest/test/playtest.test.ts` builds the bundle into a temporary directory and checks every file. It also covers the deploy helpers against wrangler's output formats, and the testers CSV against a list captured from `wrangler pages dev`.
- `game/test/session-e2e.test.ts` checks that a saved par round and a saved banked B1 round replay from their links to the same score and state hash (Rapier), and that a page without `navigator.gpu` shows the WebGPU card.
- By hand on 2026-11-02, in Cloudflare's runtime (`wrangler pages dev` 4.151.0, the built bundle):
  - the form returned 401;
  - a wrong password got 401;
  - the right password got 303 to the remembered path, then 200 for the page and its assets;
  - the headers arrived: COOP/COEP, the immutable cache on assets, and noindex;
  - an asset requested without the pass got 401;
  - the KV listed both testers;
  - Playwright went through the form, reached the front door (`crossOriginIsolated` true), pressed Play and Fire, and saw the wall come down (D 0.10).

The one step not run here is the real deploy, which needs Will's Cloudflare account.

## Alternatives considered

- **Cloudflare Access with one-time PINs (Zero Trust, free up to 50 users).** The emails would be verified and Cloudflare would maintain the gate. Rejected as the default: Will asked for a shared password, Access adds a Zero Trust setup step in the dashboard, and testers have to wait for an emailed code. It remains a fallback if the password leaks: put Access in front of the same Pages project.
- **HTTP Basic auth in the middleware.** It needs no form, but it cannot collect an email, and browser support for credentials in URLs is patchy.
- **A client-side password check.** Rejected because anyone could read it from the bundle, and the build itself would stay public.
- **Netlify or Vercel password protection.** Both are paid features, and neither collects emails.
- **A GitHub Actions deploy.** It would need a Cloudflare API token as a repo secret, and the repo is public. A deploy from Will's Mac needs only his own login. A CI deploy can be added once a token exists.
