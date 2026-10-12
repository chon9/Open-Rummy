// Bundle the server (and the workspace TS of @open-rummy/shared, and ws) into a
// single self-contained ESM file: dist/server.js. Only Node builtins stay external.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, 'dist/server.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  // ws has optional native addons loaded inside try/catch; leave them out.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS and calls require() for Node builtins; give the ESM bundle a real require.
  banner: {
    js: "import { createRequire as __orCreateRequire } from 'node:module';\nconst require = __orCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
