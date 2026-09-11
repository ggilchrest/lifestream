import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
test('voice draft validation accepts normal descriptions and gates reference consent', async () => {
  const js=await read('conversation.js');
  const source=js.slice(js.indexOf('function readVoiceSettings()'),js.indexOf('function renderProviders'));
  const values={'voice-description':{value:'A calm clear feminine voice'},'voice-seed':{value:'42'},'voice-tone':{value:'neutral'},'voice-pace':{value:'.5'},'voice-energy':{value:'.4'},'voice-reference-consent':{checked:false},'voice-reference-transcript':{value:'hello'}};
  const readDraft=new Function('$','referenceAudio','referenceSupported',`${source};return readVoiceSettings();`);
  assert.equal(readDraft(id=>values[id],null,true).description,'A calm clear feminine voice');
  for(const value of ['bad\nline','bad\rline','bad(parentheses)']){values['voice-description'].value=value;assert.throws(()=>readDraft(id=>values[id],null,true),/description/);}
  values['voice-description'].value='calm';
  assert.throws(()=>readDraft(id=>values[id],{dataBase64:'test'},true),/permission/);
  values['voice-reference-consent'].checked=true;
  assert.equal(readDraft(id=>values[id],{dataBase64:'test'},true).reference.consent,true);
  assert.equal(readDraft(id=>values[id],{dataBase64:'test'},false).reference,null);
});
test('voice test controls expose preview/apply, capability limits, and reference permission', async () => {
  const html=await read('conversation.html'),js=await read('conversation.js');
  for(const text of ['Shape the voice','Preview draft voice','Apply to live conversation','Reference audio','Exact reference transcript','I have permission','Clear reference audio','Session only']) assert.ok(html.includes(text));
  for(const text of ['referenceSupported','descriptionSupported','OfflineAudioContext','referenceGeneration','voiceDrafts','voiceSettings:{...activeVoiceSettings}','/api/runtime/v1/voice-options','action:"check"']) assert.ok(js.includes(text),text);
  assert.doesNotMatch(js,/localStorage|sessionStorage/);
});
test('browser-first conversation surface keeps physical IO in the browser', async () => {
  const html = await read('conversation.html'); const js = await read('conversation.js');
  for (const text of ['Runtime profile', 'Mac-local', 'ai5090', 'Apply profile', 'Start voice / Connect', 'Speaker test', 'Assistant TTS test', 'Assistant STT test', 'Stop response', 'Microphone', 'Conversation transcript', 'Barge-in ready', 'No voice turns yet']) assert.match(html, new RegExp(text));
  for (const text of ['getUserMedia', 'isSecureContext', 'getSettings', 'AudioContext', 'AbortController', 'WebSocket', 'commitTurn', 'stopPlayback', 'barge-in speech detected', 'voicePendingTurns', 'transcriptTurn', 'message.type==="transcript"', '/api/runtime/v1/profile', '/api/runtime/v1/messages', '/api/runtime/v1/tts', '/api/runtime/v1/stt', 'createBufferSource', 'resample16k']) assert.match(js, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(js, /SGLANG_API_KEY|30000|v1\/chat\/completions/); assert.match(js, /video:false/); assert.match(js, /Retry backend connection/); assert.match(js, /fetch\("\/health"/); assert.match(js, /configured runtime provides inference, STT, and TTS/); assert.match(js, /\/api\/runtime\/v1\/stt/); assert.match(js, /playVoiceChunk\(\{frame:event\.frame\}\)/); assert.match(js, /provider\.fixture\?"fixture":"real"/);
});
