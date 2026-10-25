// Node-only entry point (Playwright, Vite); never imported by the page.
export { runInBrowser, chromiumArgs, type BrowserRunOptions } from './orchestrate.ts';
export { parseConfig, toQuery } from './config.ts';
