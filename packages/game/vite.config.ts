import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { ISOLATION_HEADERS } from '../runner/vite.config.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { headers: ISOLATION_HEADERS, port: 5174, strictPort: false },
  preview: { headers: ISOLATION_HEADERS },
  build: { target: 'es2023' },
});
