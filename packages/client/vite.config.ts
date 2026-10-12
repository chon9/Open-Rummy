import { defineConfig } from 'vite';

/**
 * Vite config for the Open Rummy client.
 * Dev: the WebSocket endpoint `/ws` is proxied to the local game server (port 3001).
 * Build: output to dist/ (served by packages/server in production).
 */
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // three.js + three-vrm are large by nature; they load lazily with the table
    chunkSizeWarningLimit: 1600,
    assetsInlineLimit: 4096,
  },
});
