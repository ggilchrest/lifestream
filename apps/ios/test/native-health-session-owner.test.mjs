import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native Health owner uses fenced synthetic transport and drains cancellation', { timeout: 180000 }, t => {
  if (process.platform !== 'darwin') { t.skip('macOS Foundation and Xcode required'); return; }
  const ios = fileURLToPath(new URL('../', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'health-session-owner-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const derive = join(temp, 'core');
  const build = spawnSync('xcodebuild', ['-scheme', 'AssistantCore', '-configuration', 'Debug', '-destination', 'platform=macOS', '-derivedDataPath', derive, 'build'], { cwd: join(ios, 'native'), encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr + build.stdout.slice(-8000));
  const products = join(derive, 'Build/Products/Debug'), native = join(ios, 'ios/App/CapApp-SPM/Sources/CapApp-SPM');
  copyFileSync(new URL('./native-health-session-owner-probe.swift', import.meta.url), join(temp, 'main.swift'));
  const files = ['NativeTransport.swift', 'ConnectionStore.swift', 'NativeHealthPolicy.swift', 'NativeHealthDelivery.swift', 'NativeHealthSessionOwner.swift'].map(x => join(native, x));
  const compile = spawnSync('swiftc', ['-profile-generate', '-D', 'DEBUG', '-I', products, join(products, 'AssistantCore.o'), ...files, join(temp, 'main.swift'), '-o', join(temp, 'probe')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(compile.status, 0, compile.stderr);
  for (const mode of ['identity-pre-human', 'identity-pre-session', 'identity-pre-epoch', 'identity-pre-origin', 'identity-post-human', 'identity-post-session', 'identity-post-epoch', 'identity-post-origin', 'policy-epoch-race', 'invalid-presync', 'receipt-missing', 'receipt-duplicate', 'receipt-unknown', 'network-error', 'happy', 'collector-background', 'drift', 'drift-4', 'drift-generation', 'drift-endpoint-revision', 'drift-endpoint', 'drift-privacy', 'drift-ended', 'drift-5', 'drift-6', 'policy-cancel', 'collector-cancel', 'collector-hung', 'collector-late', 'sender-cancel', 'context-cancel-1', 'context-cancel-4', 'context-cancel-5', 'context-cancel-6', 'sender-duplicate']) {
    const result = spawnSync(join(temp, 'probe'), [mode], { encoding: 'utf8', timeout: 20000, env: { ...process.env, LLVM_PROFILE_FILE: join(temp, `${mode}-%p.profraw`), CALENDAR_FIXTURE: join(ios, "test/mobile-calendar-fixtures/delivery-receipts.json"), SHARE_FIXTURE: join(ios, "test/mobile-shared-item-fixtures/shared-item-pairs.json") } });
    assert.equal(result.status, 0, `${mode}: ${result.stderr} ${result.stdout}`);
    assert.match(result.stdout, new RegExp(`${mode} passed`));
  }
});
