import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQualificationReport, qualificationFailure, qualificationEvents, finishQualificationReport, holdQualificationText } from './qualification-report.mjs';

test('failed qualifications retain prior observations in a fresh private report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-report-test-'));
  try {
    const forbiddenRoot = join(root, 'repo');
    await mkdir(forbiddenRoot);
    const outputPath = join(root, 'observation.json');
    const report = { result: 'inProgress', checks: [] };
    const writer = await createQualificationReport(report, { outputPath, forbiddenRoot });
    report.checks.push({ result: 'running', observations: [{ output: 'synthetic partial reply' }] });
    await writer.save();
    assert.equal(JSON.parse(await readFile(outputPath)).checks[0].observations[0].output, 'synthetic partial reply');
    report.checks[0].result = 'fail';
    report.result = 'fail';
    await Promise.all([writer.save(), writer.save(), writer.save()]);
    assert.equal(JSON.parse(await readFile(outputPath)).result, 'fail');
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    await assert.rejects(createQualificationReport({}, { outputPath, forbiddenRoot }), { code: 'EEXIST' });
    assert.equal(JSON.parse(await readFile(outputPath)).result, 'fail');
    await assert.rejects(createQualificationReport({}, { outputPath: join(forbiddenRoot, 'bad.json'), forbiddenRoot }), /outside/);
    await symlink(forbiddenRoot, join(root, 'alias'));
    await assert.rejects(createQualificationReport({}, { outputPath: join(root, 'alias', 'bad.json'), forbiddenRoot }), /outside/);
    await symlink(outputPath, join(root, 'linked-report.json'));
    await assert.rejects(createQualificationReport({}, { outputPath: join(root, 'linked-report.json'), forbiddenRoot }), { code: 'EEXIST' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('transport diagnostics do not retain exception payloads or secrets', () => {
  assert.deepEqual(qualificationFailure(new Error('Bearer secret-value')), { name: 'OperationError' });
  assert.deepEqual(qualificationFailure(new DOMException('secret-value', 'TimeoutError')), { name: 'TimeoutError' });
  assert.deepEqual(qualificationFailure(new assert.AssertionError({ message: 'synthetic callback absent' })), {
    name: 'AssertionError', message: 'Qualification assertion failed; inspect sanitized observations.', operator: 'assertion'
  });
});

test('provider SSE errors and failed assertions cannot archive transport credentials', () => {
  const secret = 'Bearer synthetic-credential-do-not-retain';
  const stream = [
    'event: message.delta\ndata: {"interactionId":"synthetic","text":"Partial synthetic reply"}\n\n',
    `event: interaction.error\ndata: ${JSON.stringify({ code: 'inference_unavailable', message: secret, cause: { authorization: secret } })}\n\n`,
    `event: interaction.error\ndata: ${JSON.stringify({ code: secret, message: secret })}\n\n`,
    `event: unexpected-${secret}\ndata: ${JSON.stringify({ secret })}\n\n`,
    `event: message.delta\ndata: malformed ${secret}\n\n`,
  ].join('');
  const events = qualificationEvents(stream);
  assert.equal(events[0].data.text, 'Partial synthetic reply');
  assert.equal(events[1].data.code, 'inference_unavailable');
  assert.equal(events[2].data.code, 'provider_error');
  assert.equal(events[3].omitted, true);
  assert.equal(events[4].malformed, true);
  assert.equal(JSON.stringify(events).includes(secret), false);
  let failure;
  try { assert.match(stream, /event: interaction.completed/u); }
  catch (error) { failure = qualificationFailure(error); }
  assert.equal(failure.name, 'AssertionError');
  assert.equal(failure.operator, 'match');
  assert.equal(JSON.stringify(failure).includes(secret), false);
  const custom = qualificationFailure(new assert.AssertionError({ message: secret, actual: stream, expected: secret, operator: secret }));
  assert.equal(JSON.stringify(custom).includes(secret), false);
});

test('failed report persistence still attempts every cleanup and records a failing outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-cleanup-test-'));
  try {
    const forbiddenRoot = join(root, 'repo'), evidence = join(root, 'evidence');
    await mkdir(forbiddenRoot); await mkdir(evidence);
    const report = { result: 'pass' }, writer = await createQualificationReport(report, { outputPath: join(evidence, 'report.json'), forbiddenRoot });
    await rm(evidence, { recursive: true });
    const steps = [];
    await finishQualificationReport(report, () => writer.save(), [
      () => { steps.push('restore-prototypes'); },
      () => { steps.push('shutdown'); throw new Error('Bearer cleanup-secret'); },
      () => { steps.push('stop-tunnel'); },
      () => { steps.push('restore-credentials'); },
    ]);
    assert.deepEqual(steps, ['restore-prototypes', 'shutdown', 'stop-tunnel', 'restore-credentials']);
    assert.equal(report.result, 'fail');
    assert.equal(report.persistenceFailures.length, 2);
    assert.equal(report.cleanupFailures.length, 1);
    assert.equal(JSON.stringify(report).includes('cleanup-secret'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fence observation requires real nonempty text and preserves terminal provider failures', async () => {
  for (const chunk of [{ kind: 'done' }, { kind: 'error', error: { code: 'deadline_exceeded', message: 'secret' } }]) {
    const hold = { diagnostic: {}, started: performance.now(), enter: () => assert.fail('terminal event must not enter fence'), wait: new Promise(() => {}) };
    await holdQualificationText(hold, chunk);
    assert.equal(hold.entered, undefined);
    assert.equal(hold.failure, chunk.kind === 'done' ? 'terminal_before_text' : 'deadline_exceeded');
    assert.equal(JSON.stringify(hold.diagnostic).includes('secret'), false);
  }
  let entered = 0, release;
  const hold = { diagnostic: {}, started: performance.now(), enter: () => entered++, wait: new Promise(resolve => { release = resolve; }) };
  await holdQualificationText(hold, { kind: 'text', text: '' });
  assert.equal(entered, 0);
  const held = holdQualificationText(hold, { kind: 'text', text: 'synthetic' });
  assert.equal(entered, 1);
  assert.ok(hold.diagnostic.firstTextMs >= 0);
  release();
  await held;
  await holdQualificationText(hold, { kind: 'text', text: 'next' });
  assert.equal(entered, 1);
});
