// Isolated, persistent synthetic Human review. Does not change provider services.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, chmod, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLifestreamServer } from '../apps/server/src/index.ts';
import { loadProfile } from '../apps/server/src/config/loader.ts';
import { loadWindowsKey, sshArgs } from '../../orchestration/scripts/start-conversation.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/start-relationship-review.mjs [--directory EXISTING_REVIEW_DIRECTORY] [--port 43181]\nNew runs create an isolated synthetic review directory. Reuse that exact directory to test restart. Ctrl+C stops only this app and its owned SSH tunnel.');
  process.exit(0);
}
const values = {};
for (let n = 0; n < args.length; n += 2) {
  assert.ok(['--directory', '--port'].includes(args[n]) && args[n + 1], 'Unknown or incomplete option; use --help.');
  values[args[n]] = args[n + 1];
}
const port = Number(values['--port'] ?? 43181);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Use an unprivileged TCP port.');
const listening = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(500);
  for (const event of ['connect', 'error', 'timeout']) socket.once(event, () => { socket.destroy(); resolve(event === 'connect'); });
});
let app, tunnel;
const close = async () => { await app?.shutdown(); tunnel?.kill('SIGTERM'); delete process.env.LIFESTREAM_INFERENCE_API_KEY; };
try {
  assert.equal(await listening(port), false, 'Review port is already in use; choose --port or stop your existing review app.');
  const directory = values['--directory'] ? await realpath(resolve(values['--directory'])) : await mkdtemp(join(tmpdir(), 'lifestream-human-review-'));
  const marker = join(directory, 'review-environment.json');
  if (values['--directory']) {
    const saved = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(saved.kind, 'lifestream-synthetic-human-review-v1', 'Only a directory created by this launcher may be resumed.');
    assert.equal(saved.profile, 'ai5090');
  } else {
    await chmod(directory, 0o700);
    await writeFile(marker, JSON.stringify({ kind: 'lifestream-synthetic-human-review-v1', profile: 'ai5090', createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'installer-token.txt'), randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  }
  const ports = await Promise.all([43000, 48080, 48787].map(listening));
  assert.ok(ports.every(Boolean) || ports.every(v => !v), 'Selected-provider tunnel is incomplete. Resolve the existing tunnel before starting review.');
  if (!ports.every(Boolean)) {
    tunnel = spawn('ssh', sshArgs(), { stdio: ['ignore', 'ignore', 'ignore'] });
    let failed = false;
    tunnel.once('error', () => { failed = true; });
    tunnel.once('exit', () => { failed = true; });
    for (let n = 0; n < 40 && !failed && !(await listening(43000)); n++) await new Promise(r => setTimeout(r, 250));
    assert.ok(!failed && (await Promise.all([43000, 48080, 48787].map(listening))).every(Boolean), 'Selected-provider tunnel unavailable.');
  }
  process.env.LIFESTREAM_INFERENCE_API_KEY = await loadWindowsKey();
  const config = loadProfile('ai5090');
  config.authority.authentication = 'local-password';
  config.storage = { databasePath: join(directory, 'data.sqlite'), artifactDirectory: join(directory, 'artifacts') };
  app = createLifestreamServer({ config, host: '127.0.0.1', port, localAuth: { stateDirectory: join(directory, 'safety'), installerToken: (await readFile(join(directory, 'installer-token.txt'), 'utf8')).trim() } });
  await app.start();
  if (app.health.status !== 'ready') {
    const required = Object.values(app.health.providers)
      .filter(provider => provider.required && provider.status !== 'healthy')
      .map(provider => `${provider.id}=${provider.status}${provider.reason ? ` (${provider.reason})` : ''}`)
      .join('; ');
    throw new Error(`Selected providers are not ready; no fixture fallback was substituted. Required provider status: ${required || 'unknown'}.`);
  }
  console.log(`Review app: http://127.0.0.1:${app.address().port}/control/\nReview directory: ${directory}\nFirst enrollment token file: ${join(directory, 'installer-token.txt')}\nUse synthetic inputs only. Keep the safety directory with this review; it must remain current when restoring the database.\nCtrl+C stops this review app. Restart with --directory and the path above.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().then(() => process.exit(0)); });
} catch (error) {
  await close();
  console.error(error instanceof Error ? error.message : 'Review startup failed. Check the review directory and existing selected-provider access; credentials are not logged.');
  process.exitCode = 1;
}
