// Node-only entry point (Playwright, Vite); never imported by the page.
export { runInBrowser, openRunner, chromiumArgs, type BrowserRunOptions, type RunnerSession } from './orchestrate.ts';
export * from './suite.ts';
export { parseConfig, toQuery } from './config.ts';
