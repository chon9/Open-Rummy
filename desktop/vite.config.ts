/**
 * Renderer build for the desktop app: reuses packages/client unchanged and emits it to
 * desktop/dist/renderer, served by the main process at app://open-rummy/.
 * Run with the root workspace's vite (see package.json "build:renderer"); nothing is installed
 * in the root for the desktop app.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(here, '../packages/client'),
  base: './',
  // --config points here, so the client's own vite.config.ts (dev proxy etc.) is not loaded
  define: {
    __DESKTOP__: 'true',
  },
  build: {
    target: 'es2022',
    outDir: path.resolve(here, 'dist/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
    assetsInlineLimit: 4096,
  },
});
