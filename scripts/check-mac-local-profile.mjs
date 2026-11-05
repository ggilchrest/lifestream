#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifestreamServer } from '../apps/server/src/index.ts';
import { loadProfile } from '../apps/server/src/config/loader.ts';

const root = await mkdtemp(join(tmpdir(), 'lifestream-mac-local-'));
const selected = loadProfile('mac-local');
const config = {
  ...selected,
  storage: { databasePath: join(root, 'data.sqlite'), artifactDirectory: join(root, 'artifacts') }
};
const app = createLifestreamServer({ config });
try {
  await app.start();
  const base = `http://127.0.0.1:${app.address().port}`;
  const healthResponse = await fetch(`${base}/health/ready`);
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.status !== 'ready' || health.acceptingInteractions !== true) throw new Error('Mac-local Lifestream composition is not ready');
  for (const id of ['inference', 'stt', 'tts']) {
    if (health.providers?.[id]?.required !== true || health.providers[id].status !== 'healthy' || health.providers[id].fixture !== false) throw new Error(`Mac-local ${id} is not a healthy required real provider`);
  }
  const response = await fetch(`${base}/api/runtime/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lifestream-fixture-session': 'mac-local-smoke', 'x-lifestream-fixture-principal': 'operator', origin: base },
    body: JSON.stringify({ userInput: 'Reply with exactly MAC_PROFILE_READY' })
  });
  const stream = await response.text();
  const generated = [...stream.matchAll(/^data: (.+)$/gmu)].map((match) => JSON.parse(match[1])).map((event) => event.text).filter((text) => typeof text === 'string').join('');
  if (!response.ok || generated.trim() !== 'MAC_PROFILE_READY' || !stream.includes('event: interaction.completed')) throw new Error('Mac-local canonical inference route did not complete as expected');
  console.log(JSON.stringify({ profile: health.profile, status: health.status, acceptingInteractions: health.acceptingInteractions, providers: { inference: health.providers.inference, stt: health.providers.stt, tts: health.providers.tts }, canonicalInferenceResponse: 'MAC_PROFILE_READY', storage: 'temporary' }, null, 2));
} finally {
  await app.shutdown();
  await rm(root, { recursive: true, force: true });
}
