import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Cross-origin isolation gives 5 µs performance.now() resolution (100 µs
// without) and enables SharedArrayBuffer for threaded WASM engines.
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { headers: ISOLATION_HEADERS, strictPort: false },
  preview: { headers: ISOLATION_HEADERS },
  build: { target: 'es2023' },
  logLevel: 'warn',
});
