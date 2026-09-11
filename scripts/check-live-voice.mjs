// Opt-in real-provider development check. No microphone capture or audio files.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.LIFESTREAM_URL || 'http://127.0.0.1:3910';
const headers = { 'content-type': 'application/json', 'x-lifestream-fixture-session': 'voice-recovery-check', 'x-lifestream-fixture-principal': 'human' };
const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).json();
for (const name of ['stt', 'tts', 'inference']) assert.equal(health.providers[name].fixture, false, `${name} must be real`);
const synthesize = async text => {
  const started = performance.now();
  const result = await fetch(`${base}/api/runtime/v1/tts`, { method: 'POST', headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000) });
  assert.equal(result.status, 200);
  const events = (await result.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).outcome, 'succeeded', JSON.stringify(events.at(-1)));
  const pcm = Buffer.concat(events.filter(event => event.kind === 'data').map(event => Buffer.from(event.frame.dataBase64, 'base64')));
  assert.ok(pcm.length > 0);
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
  const rms = Math.sqrt(energy / (pcm.length / 2));
  assert.ok(rms > 0.001, 'synthesis must not be silent');
  console.log(JSON.stringify({ check: 'real-synthesis', frames: events.filter(e => e.kind === 'data').length, samples: pcm.length / 2, rms, elapsedMs: Math.round(performance.now() - started) }));
  return pcm;
};
await synthesize('This is a live Assistant text to speech test.');
const to16k = pcm48 => {
  const pcm16 = Buffer.alloc(Math.floor(pcm48.length / 6) * 2);
  for (let i = 0; i < pcm16.length / 2; i++) pcm16.writeInt16LE(Math.round((pcm48.readInt16LE(i * 6) + pcm48.readInt16LE(i * 6 + 2) + pcm48.readInt16LE(i * 6 + 4)) / 3), i * 2);
  return pcm16;
};
const interruptPcm = to16k(await synthesize('Say hello. Then count from one to twenty.'));
const recoveryPcm = to16k(await synthesize('Reply with just the word hello.'));
const sessionId = randomUUID(), audioInputId = randomUUID();
const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/runtime/v1/audio?fixtureSession=${sessionId}&fixturePrincipal=human`);
const events = [];
socket.addEventListener('message', event => events.push(JSON.parse(event.data)));
const wait = async predicate => {
  const end = Date.now() + 185000;
  while (!predicate()) {
    assert.ok(Date.now() < end, `voice timed out: ${JSON.stringify(events.map(e => ({type:e.type, payload:e.event?.payload?.type, state:e.event?.payload?.state, problem:e.problem})))}`);
    assert.notEqual(socket.readyState, WebSocket.CLOSED, 'voice socket unexpectedly closed');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const send = value => socket.send(JSON.stringify(value));
const submit = (pcm16 = interruptPcm) => {
  let sequence = 0;
  for (let offset = 0; offset < pcm16.length; offset += 9600) {
    const bytes = pcm16.subarray(offset, offset + 9600);
    send({ type:'frame', audioInputId, frame: { frameId: randomUUID(), sequence: sequence++, sampleOffset: offset / 2, sampleCount: bytes.length / 2, format: { encoding:'pcm_s16le', sampleRateHz:16000, channels:1 }, dataBase64:bytes.toString('base64') } });
  }
  send({ type:'commitTurn', audioInputId, nextSequence:sequence, sampleCount:pcm16.length / 2 });
};
try {
  await wait(() => socket.readyState === WebSocket.OPEN);
  send({ type:'start', request: { schemaVersion:'1.0.0', requestId:randomUUID(), correlationId:randomUUID(), sessionId, expectedSessionRevision:1, endpointId:randomUUID(), audioInputId, format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1} } });
  await wait(() => events.some(e => e.type === 'accepted'));
  submit();
  for (let turn = 0; turn < 5; turn++) {
    await wait(() => events.filter(e => e.type === 'turnStarted').length > turn);
    const trace = events.filter(e => e.type === 'turnStarted')[turn].interactionTraceId;
    const terminal = () => events.find(e => e.type === 'response' && e.event.interactionTraceId === trace && e.event.payload.type === 'terminal');
    await wait(() => events.some(e => e.type === 'audio' && e.interactionTraceId === trace) || terminal());
    assert.ok(events.some(e => e.type === 'audio' && e.interactionTraceId === trace), `no audio: ${JSON.stringify(terminal())}`);
    // Interrupt two turns while submitting the next utterance on the same socket.
    if (turn < 2) { send({type:'interrupt',interactionTraceId:trace,reason:'automated barge-in recovery check'}); submit(); }
    await wait(terminal);
    const transcription = events.find(e => e.type === 'transcript' && e.interactionTraceId === trace);
    assert.ok(transcription?.text);
    const payload=terminal().event.payload;
    console.log(JSON.stringify({ check:'real-voice-turn', turn:turn + 1, transcript:transcription.text, audioFrames:events.filter(e => e.type === 'audio' && e.interactionTraceId === trace).length, terminal:payload.state, error:payload.error }));
    if(turn>=2) assert.equal(payload.state,'completed',JSON.stringify(payload));
    else assert.equal(payload.state, turn < 2 ? 'interrupted' : 'completed', JSON.stringify(payload));
    if (turn >= 2 && turn < 4) submit(recoveryPcm);
  }
  assert.equal(events.filter(e => e.type === 'error').length, 0);
} finally { socket.close(); }
await synthesize('Speech is still working after the conversation.');
console.log(JSON.stringify({ check:'voice-recovery', result:'pass', profile:health.profile, providers:health.providers, exclusions:['physical microphone','physical audibility','human acceptance','production qualification'] }));
