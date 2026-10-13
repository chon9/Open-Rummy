// Bundles the Electron main + preload scripts into dist/ (renderer is built by vite.config.ts).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // electron is provided by the runtime; steamworks.js is a native module loaded from node_modules
  external: ['electron', 'steamworks.js'],
  absWorkingDir: here,
};

await build({ ...common, entryPoints: { main: 'src/main.ts' }, outdir: 'dist' });
// sandboxed preload: a single file, only `electron` may be required
await build({ ...common, entryPoints: { preload: 'src/preload.ts' }, outdir: 'dist', external: ['electron'] });

// optional window icon: build-resources/icon.ico|png -> dist/ (main.ts picks it up when present)
for (const name of ['icon.ico', 'icon.png']) {
  const src = path.join(here, 'build-resources', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(here, 'dist', name));
}

if (watch) console.log('watch mode is not implemented; re-run npm run build:main');
