import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'apps/server'],
  { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
await require('esbuild').build({
  absWorkingDir: root, entryPoints: ['apps/control-web/vad-source.js'],
  bundle: true, format: 'esm', outfile: 'apps/control-web/vad-bundle.js',
});
