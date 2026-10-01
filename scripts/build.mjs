import { spawnSync } from 'node:child_process';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const projects = ['apps/server', 'packages/contracts', 'packages/runtime',
  'packages/providers-fixture', 'packages/providers-voxcpm', 'packages/providers-nemo-speech',
  'packages/providers-moonshine', 'packages/providers-ollama', 'packages/providers-pwce',
  'packages/providers-sglang', 'packages/storage-sqlite', 'packages/providers-bizhawk'];
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run([join(root, 'node_modules/typescript/bin/tsc'), '-b', ...projects]);
run([join(root, 'scripts/build-server.mjs')]);
for (const [source, destination, suffix] of [
  ['apps/server/src/config/profiles', 'apps/server/dist/config/profiles', '.json'],
  ['packages/storage-sqlite/src/migrations', 'packages/storage-sqlite/dist/migrations', '.sql'],
  ['packages/contracts/src/schemas', 'packages/contracts/dist/schemas', '.json'],
]) {
  await mkdir(join(root, destination), { recursive: true });
  for (const name of await readdir(join(root, source))) {
    if (name.endsWith(suffix)) await copyFile(join(root, source, name), join(root, destination, name));
  }
}
