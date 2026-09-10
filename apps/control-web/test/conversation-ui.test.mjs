import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
test('browser-first conversation surface keeps physical IO in the browser', async () => {
  const html = await read('conversation.html'); const js = await read('conversation.js');
  for (const text of ['Start voice / Connect', 'Speaker test', 'Stop response', 'Microphone']) assert.match(html, new RegExp(text));
  for (const text of ['getUserMedia', 'isSecureContext', 'getSettings', 'AudioContext', 'AbortController', '/api/runtime/v1/messages']) assert.match(js, new RegExp(text.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')));
  assert.doesNotMatch(js, /SGLANG_API_KEY|30000|ai5090|v1\/chat\/completions/); assert.match(js, /video:false/);
});
