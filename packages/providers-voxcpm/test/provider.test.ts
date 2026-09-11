import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { VoxCpmProvider } from "../src/provider.ts";
import { parseNdjson, validateProtocolEvents } from "../src/protocol.ts";

const request = { contractVersion: "2.0.0" as const, deadlineAt: new Date(Date.now() + 60_000).toISOString(), now: () => "2026-09-07T00:00:00Z", text: "Hello", segmentId: "segment-1", format: { encoding: "pcm_s16le" as const, sampleRateHz: 48000 as const, channels: 1 as const }, voiceProfile: { voiceRef: "opaque-voice", revision: 1 }, decision: { decisionId: "decision-1", revision: 2, valence: 0, arousal: 0.4, urgency: "normal" as const, deliveryMode: "neutral" as const, pace: 0.5, energy: 0.5 }, delivery: { interactionId: "interaction-1", segmentId: "segment-1", decisionId: "decision-1", decisionRevision: 2, deliveryMode: "neutral" as const, urgency: "normal" as const, pace: 0.5, energy: 0.5 } };
const response = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
const stream = () => JSON.stringify({ kind: "preAudio", sequence: 0, requestId: "interaction-1:segment-1", correlationId: "decision-1", voiceBundleRevision: 1, requestedDelivery: request.delivery, appliedDelivery: request.delivery, degradedDimensions: [], mappingRevision: "voxcpm2-map-1", effectiveSynthesis: { mode: "neutral" }, format: request.format, runtimeRevision: "19b6bf7590025418821a86dcb817504e0ad7e5df", modelRevision: "hf-snapshot" }) + "\n" + JSON.stringify({ kind: "data", sequence: 1, sampleOffset: 0, sampleCount: 10, dataBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", format: request.format }) + "\n" + JSON.stringify({ kind: "terminal", sequence: 2, outcome: "completed", outputSamples: 10, frameCount: 1 }) + "\n";

test("internal diagnostics distinguish busy and redact arbitrary transport messages",async()=>{
  const diagnostics:unknown[]=[];
  for(const busy of [true,false]){
    const provider=new VoxCpmProvider({baseUrl:"http://tts.invalid",voiceBundleKey:"fixture",voiceBundleRevision:1,runtimeRevision:"r",modelRevision:"m",mappingRevision:"map",onDiagnostic:event=>diagnostics.push(event),fetch:async()=>{if(!busy)throw new Error("private request or secret");return response(JSON.stringify({kind:"terminal",sequence:0,outcome:"providerUnavailable",outputSamples:0,frameCount:0})+"\n");}});
    for await(const event of provider.synthesize(request))assert.equal(event.kind,"terminal");
  }
  assert.deepEqual(diagnostics,[{requestId:"interaction-1:segment-1",code:"busy_admission_retry"},{requestId:"interaction-1:segment-1",code:"busy_admission_retry"},{requestId:"interaction-1:segment-1",code:"remote:providerUnavailable"},{requestId:"interaction-1:segment-1",code:"transport_or_parse_failure"}]);
});
test("busy admission retries have no duplicate audio and preserve the original deadline",async()=>{
  const deadlines:string[]=[];
  const provider=new VoxCpmProvider({baseUrl:"http://tts.invalid",voiceBundleKey:"fixture",voiceBundleRevision:1,runtimeRevision:"19b6bf7590025418821a86dcb817504e0ad7e5df",modelRevision:"hf-snapshot",mappingRevision:"voxcpm2-map-1",fetch:async(_url,init)=>{deadlines.push(JSON.parse(String(init?.body)).deadlineAt);return response(deadlines.length<3?JSON.stringify({kind:"terminal",sequence:0,outcome:"providerUnavailable",outputSamples:0,frameCount:0})+'\n':stream());}});
  const events=[];for await(const event of provider.synthesize(request))events.push(event);
  assert.deepEqual(events.map(e=>e.kind),['preAudio','data','terminal']);assert.deepEqual(deadlines,[request.deadlineAt,request.deadlineAt,request.deadlineAt]);
});

test("negotiated voice controls remain available while the single worker is busy", async () => {
  let calls=0;
  const provider=new VoxCpmProvider({baseUrl:"http://tts.invalid",voiceBundleKey:"fixture",voiceBundleRevision:1,runtimeRevision:"r",modelRevision:"m",mappingRevision:"map",fetch:async()=>{calls++;if(calls>1)throw new Error("worker busy");return Response.json({voiceDesignControl:"voxcpm.voice-design.v1",voiceReferenceControl:"voxcpm.voice-reference.v1"});}});
  assert.deepEqual(await provider.voiceControls(),{description:true,reference:true});
  assert.deepEqual(await provider.withVoiceDesign({description:"steady",seed:0}).voiceControls(),{description:true,reference:true});
  assert.equal(calls,1);
});

test("abandoning TTS after pre-audio cancels the HTTP body and releases its reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(stream().split("\n")[0] + "\n")); },
    cancel() { cancelled = true; }
  });
  const provider = new VoxCpmProvider({ baseUrl: "http://tts.invalid", voiceBundleKey: "fixture", voiceBundleRevision: 1, runtimeRevision: "19b6bf7590025418821a86dcb817504e0ad7e5df", modelRevision: "hf-snapshot", mappingRevision: "voxcpm2-map-1", fetch: async () => new Response(body) });
  for await (const event of provider.synthesize({ ...request, deadlineAt: new Date(Date.now() + 5000).toISOString() })) { assert.equal(event.kind, "preAudio"); break; }
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("voice conditioning stays separate from spoken text and fails if ignored", async () => {
  let sent: Record<string, unknown> = {};
  const provider = new VoxCpmProvider({ baseUrl:"http://tts.invalid", voiceBundleKey:"fixture",voiceBundleRevision:1,runtimeRevision:"19b6bf7590025418821a86dcb817504e0ad7e5df",modelRevision:"hf-snapshot",mappingRevision:"voxcpm2-map-1",fetch:async(_url,init)=>{sent=JSON.parse(String(init?.body));return response(stream());} }).withVoiceDesign({description:"A steady adult voice",seed:42});
  const events=[];for await(const event of provider.synthesize(request))events.push(event);
  assert.equal(sent.text,"Hello");assert.deepEqual(sent.voiceDesign,{version:"voxcpm.voice-design.v1",description:"A steady adult voice",seed:42});
  assert.equal(events.at(-1)?.outcome,"failed");assert.equal(events.some(event=>event.kind==="data"),false);
});

test("reference digest and continuation mode must be acknowledged before audio", async () => {
  const reference={dataBase64:Buffer.alloc(64000).toString("base64"),sampleRateHz:16000 as const,transcript:"Hello"};
  const referenceDigest=createHash("sha256").update(Buffer.from(reference.dataBase64,"base64")).digest("hex");
  for(const mode of ["continuation","reference","missing-digest"]){
    const lines=stream().trim().split("\n").map(line=>JSON.parse(line));
    lines[0].effectiveSynthesis={voiceDescription:"",seed:42,referenceDigest:mode==="missing-digest"?null:referenceDigest,conditioningMode:mode};
    const provider=new VoxCpmProvider({baseUrl:"http://tts.invalid",voiceBundleKey:"fixture",voiceBundleRevision:1,runtimeRevision:"19b6bf7590025418821a86dcb817504e0ad7e5df",modelRevision:"hf-snapshot",mappingRevision:"voxcpm2-map-1",fetch:async()=>response(lines.map(line=>JSON.stringify(line)).join("\n")+"\n")}).withVoiceDesign({description:"",seed:42,reference});
    const events=[];for await(const event of provider.synthesize(request))events.push(event);
    assert.equal(events.at(-1)?.outcome,mode==="continuation"?"succeeded":"failed");assert.equal(events.some(event=>event.kind==="data"),mode==="continuation");
  }
});

test("VoxCPM adapter maps the private preAudio/data/terminal protocol", async () => { const provider = new VoxCpmProvider({ baseUrl: "http://127.0.0.1:8787", voiceBundleKey: "fixture-voice-design", voiceBundleRevision: 1, runtimeRevision: "19b6bf7590025418821a86dcb817504e0ad7e5df", modelRevision: "hf-snapshot", mappingRevision: "voxcpm2-map-1", fetch: async () => response(stream()) }); const events = []; for await (const event of provider.synthesize(request)) events.push(event); assert.deepEqual(events.map((event) => event.kind), ["preAudio", "data", "terminal"]); assert.equal(events[0]?.decisionId, "decision-1"); assert.equal(events[1]?.frame.sampleOffset, 0); assert.equal(events.at(-1)?.outcome, "succeeded"); });
test("VoxCPM adapter fences cancellation, accepts terminal-only rejection, and validates malformed protocol", async () => { const controller = new AbortController(); controller.abort(); const provider = new VoxCpmProvider({ baseUrl: "http://127.0.0.1:8787", voiceBundleKey: "fixture", voiceBundleRevision: 1, runtimeRevision: "r", modelRevision: "m", mappingRevision: "map", fetch: async () => { throw new Error("aborted"); } }); const events = []; for await (const event of provider.synthesize(request, controller.signal)) events.push(event); assert.equal(events.at(-1)?.outcome, "cancelled"); const deadlineProvider = new VoxCpmProvider({ baseUrl: "http://127.0.0.1:8787", voiceBundleKey: "fixture", voiceBundleRevision: 1, runtimeRevision: "r", modelRevision: "m", mappingRevision: "map", fetch: async () => response(JSON.stringify({ kind: "terminal", sequence: 0, outcome: "deadlineExceeded", outputSamples: 0, frameCount: 0 }) + "\n") }); const rejected = []; for await (const event of deadlineProvider.synthesize(request)) rejected.push(event); assert.equal(rejected.at(-1)?.outcome, "timedOut"); assert.throws(() => validateProtocolEvents(parseNdjson(JSON.stringify({ kind: "data", sequence: 0, sampleOffset: 0, sampleCount: 1, dataBase64: "AAAA", format: request.format }))), /lifecycle/); });
