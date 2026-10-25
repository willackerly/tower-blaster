import { parseConfig } from './config.ts';
import { execute } from './run-config.ts';

type Status = 'idle' | 'running' | 'done' | 'error';
interface Handle { status: Status; result: unknown; error: string | null; progress: string }

declare global { interface Window { __tb: Handle } }

const handle: Handle = { status: 'idle', result: null, error: null, progress: '' };
window.__tb = handle;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const query = $<HTMLInputElement>('query'), statusEl = $('status'), out = $('out');
query.value = location.search.slice(1);

function set(status: Status, text: string) {
  handle.status = status;
  statusEl.textContent = text;
}

async function run() {
  try {
    const config = parseConfig(`?${query.value}`);
    set('running', 'running…');
    handle.result = await execute(config, (m) => { handle.progress = m; statusEl.textContent = m; });
    out.textContent = JSON.stringify(handle.result, null, 2);
    set('done', 'done');
  } catch (e) {
    handle.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    out.textContent = handle.error;
    set('error', 'error');
  }
}

$('run').addEventListener('click', () => {
  history.replaceState(null, '', `?${query.value}`);
  void run();
});
if (parseConfig(location.search).autorun) void run();
