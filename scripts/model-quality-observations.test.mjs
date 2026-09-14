import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifierObservation, modelQuality, persistModelQuality } from './model-quality-observations.mjs';

test('model telemetry separates case variance, omission, and embedded or altered tokens', () => {
  const samples = ['SYNPRJ_Q7M4', 'SynPRJ_Q7M4', '', 'XSYNPRJ_Q7M4', 'SYNPRJ_Q7M4X', 'SYNPRJ_Q7M5']
    .map((output, i) => identifierObservation(String(i), 'SYNPRJ_Q7M4', output));
  assert.deepEqual(modelQuality(samples).counts, { exact: 1, capitalizationOnly: 1, missingCompleteIdentifier: 4 });
  assert.equal(modelQuality(samples).identifierPresenceRate, 2 / 6);
  assert.equal(modelQuality([]).identifierPresenceRate, null);
  assert.equal(modelQuality(samples).blocking, false);
});

test('partial failed journeys persist observations without duplicate report counting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ls-model-quality-')); t.after(() => rm(root, { recursive: true, force: true }));
  const report = { slice: 'LS-S075', collectedAt: '2026-09-14T00:00:00Z', result: 'fail',
    joinedEvidence: { modelQuality: modelQuality([identifierObservation('admitted', 'SYNPRJ_Q7M4', 'No marker')]) } };
  await persistModelQuality(root, report); await persistModelQuality(root, report);
  assert.equal((await readdir(join(root, '.lifestream/model-quality'))).length, 1);
  await persistModelQuality(root, { ...report, collectedAt: '2026-09-14T00:01:00Z' });
  assert.equal((await readdir(join(root, '.lifestream/model-quality'))).length, 2);
});
