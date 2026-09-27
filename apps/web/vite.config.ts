/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Issue #87: @epgs/shared-types now exports a runtime VALUE
    // (SEMANTIC_INTENT_MAX_LENGTH) that the config UI reads, not only types.
    // The package compiles to CommonJS for api/worker, and Rollup's
    // commonjs plugin only transforms files under node_modules by default -
    // pnpm's symlink resolves the real path to packages/shared-types/dist,
    // so the re-export (`__exportStar`) was invisible to the bundler and the
    // named import failed the production build. Aliasing to the TS source
    // makes Vite bundle it from ESM source instead. tsc still reads the
    // published dist/*.d.ts for types, so nothing else changes for consumers.
    alias: {
      '@epgs/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    host: process.env.VITE_DEV_HOST || undefined,
    // API calls are relative to the page's own origin at runtime (see
    // apps/web/src/authApi.ts) - the dev server proxies them to the api
    // process so `pnpm dev` still works without a build-time base URL.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
  },
});
