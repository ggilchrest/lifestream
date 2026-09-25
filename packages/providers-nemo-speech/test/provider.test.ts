import assert from "node:assert/strict";
import { test } from "node:test";
import { NemoSpeechProvider } from "../src/provider.ts";

const format = { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const };
const audio = async function* () { yield { type: "frame" as const, audioInputId: "input-1", frame: { frameId: "frame-1", sequence: 0, format, sampleOffset: 0, sampleCount: 4, dataBase64: "AAAAAAAAAAA=" } }; yield { type: "end" as const, audioInputId: "input-1", nextSequence: 1, sampleCount: 4 }; };

class FakeSocket {
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null; sent: (string | ArrayBuffer)[] = [];
  send(data: string | ArrayBuffer): void { this.sent.push(data); if (typeof data === "string" && data.includes("input_audio_buffer.commit")) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "hello" }) })); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello." }) })); } }
  close(): void { this.onclose?.(); }
}
test("NeMo cancellation and deadlines settle both unopened and silent sockets",async()=>{
  for(const open of [false,true])for(const cancel of [false,true]){
    const socket=new FakeSocket();socket.send=data=>socket.sent.push(data);
    const controller=new AbortController();
    const provider=new NemoSpeechProvider({baseUrl:'http://stt.invalid',model:'test',webSocketFactory:()=>{if(open)queueMicrotask(()=>socket.onopen?.());return socket;}});
    const timer=cancel?setTimeout(()=>controller.abort(),10):undefined;
    try{const events=[];for await(const event of provider.transcribe({deadlineAt:new Date(Date.now()+25).toISOString(),now:()=>new Date().toISOString()},audio(),controller.signal))events.push(event);
      assert.equal(events.at(-1)?.outcome,cancel?'cancelled':'timedOut');assert.equal(socket.onmessage,null);assert.equal(socket.onclose,null);
    }finally{clearTimeout(timer);}
  }
});
test("abandoning a partial transcript closes and detaches the NeMo transport",async()=>{
  const socket=new FakeSocket();let closed=0;socket.close=()=>{closed++;socket.onclose?.();};
  const provider=new NemoSpeechProvider({baseUrl:'http://stt.invalid',model:'test',webSocketFactory:()=>{queueMicrotask(()=>socket.onopen?.());return socket;}});
  for await(const event of provider.transcribe({deadlineAt:new Date(Date.now()+1000).toISOString(),now:()=>new Date().toISOString()},audio())){assert.equal(event.kind,'data');break;}
  assert.ok(closed>0);assert.equal(socket.onmessage,null);
});

test("NeMo adapter maps realtime partial and committed events without claiming turn authority", async () => {
  const socket = new FakeSocket();
  const provider = new NemoSpeechProvider({ baseUrl: "http://127.0.0.1:8080", model: "nemotron-en", webSocketFactory: () => { queueMicrotask(() => socket.onopen?.()); return socket; } });
  const events = []; for await (const event of provider.transcribe({ deadlineAt: "2026-09-08T00:01:00Z", now: () => "2026-09-08T00:00:00Z" }, audio())) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), ["data", "data", "terminal"]);
  assert.equal(events[0]?.payload.type, "partial"); assert.equal(events[1]?.payload.type, "committed"); assert.equal(events.at(-1)?.outcome, "succeeded");
  assert.equal(events[1]?.payload.text, "hello.");
  assert.equal(typeof socket.sent[0], "string"); assert.match(String(socket.sent[0]), /session\.update/); assert.equal(socket.sent.length, 3);
});

test("NeMo adapter fences cancellation and rejects non-16k or non-contiguous PCM before transport", async () => {
  let opened = false; const socket = new FakeSocket(); const provider = new NemoSpeechProvider({ baseUrl: "http://127.0.0.1:8080", model: "nemotron-en", webSocketFactory: () => { opened = true; queueMicrotask(() => socket.onopen?.()); return socket; } });
  const controller = new AbortController(); controller.abort(); const cancelled = []; for await (const event of provider.transcribe({ deadlineAt: "2026-09-08T00:01:00Z", now: () => "2026-09-08T00:00:00Z" }, audio(), controller.signal)) cancelled.push(event); assert.equal(cancelled.at(-1)?.outcome, "cancelled"); assert.equal(opened, false);
  const invalidSocket = new FakeSocket(); const invalidProvider = new NemoSpeechProvider({ baseUrl: "http://127.0.0.1:8080", model: "nemotron-en", webSocketFactory: () => { queueMicrotask(() => invalidSocket.onopen?.()); return invalidSocket; } });
  const invalid = async function* () { yield { type: "frame" as const, audioInputId: "bad", frame: { frameId: "f", sequence: 1, format, sampleOffset: 0, sampleCount: 4, dataBase64: "AAAAAAAAAAA=" } }; };
  const rejected = []; for await (const event of invalidProvider.transcribe({ deadlineAt: "2026-09-08T00:01:00Z", now: () => "2026-09-08T00:00:00Z" }, invalid())) rejected.push(event); assert.equal(rejected.at(-1)?.outcome, "failed"); assert.equal(invalidSocket.sent.length, 1); assert.match(String(invalidSocket.sent[0]), /session\.update/);
});

test('NeMo coalesces irregular device frames into bounded messages without losing, duplicating or reordering samples',async()=>{
 const socket=new FakeSocket(),provider=new NemoSpeechProvider({baseUrl:'http://stt.invalid',model:'test',webSocketFactory:()=>{queueMicrotask(()=>socket.onopen?.());return socket;}});
 const counts=[320,480,320,4800,37],expected=Buffer.alloc(counts.reduce((n,c)=>n+c,0)*2);for(let n=0;n<expected.length/2;n++)expected.writeInt16LE((n%2000)-1000,n*2);
 async function* stream(){let offset=0;for(const [sequence,count] of counts.entries()){yield {type:'frame' as const,audioInputId:'irregular',frame:{frameId:String(sequence),sequence,format,sampleOffset:offset,sampleCount:count,dataBase64:expected.subarray(offset*2,(offset+count)*2).toString('base64')}};offset+=count;}yield {type:'end' as const,audioInputId:'irregular',nextSequence:counts.length,sampleCount:offset};}
 const events=[];for await(const event of provider.transcribe({deadlineAt:new Date(Date.now()+1000).toISOString(),now:()=>new Date().toISOString()},stream()))events.push(event);
 const binary=socket.sent.filter((value):value is ArrayBuffer=>typeof value!=='string').map(value=>Buffer.from(value));assert.deepEqual(binary.map(b=>b.length),[3200,3200,3200,2314]);assert.deepEqual(Buffer.concat(binary),expected);assert.match(String(socket.sent.at(-1)),/input_audio_buffer.commit/);assert.equal(events.at(-1)?.inputSamples,5957);assert.equal(events.at(-1)?.outcome,'succeeded');
});

test('NeMo drops an unsent short remainder on cancellation, deadline or invalid end',async()=>{
 for(const mode of ['cancel','deadline','invalid'] as const){const socket=new FakeSocket(),controller=new AbortController();let now=0;
 const provider=new NemoSpeechProvider({baseUrl:'http://stt.invalid',model:'test',webSocketFactory:()=>{queueMicrotask(()=>socket.onopen?.());return socket;}});
 async function* stream(){yield {type:'frame' as const,audioInputId:'pending',frame:{frameId:'0',sequence:0,format,sampleOffset:0,sampleCount:4,dataBase64:'AAAAAAAAAAA='}};assert.equal(socket.sent.length,1,'Short tail must remain unsent');if(mode==='cancel')controller.abort();if(mode==='deadline')now=2000;yield {type:'end' as const,audioInputId:'pending',nextSequence:mode==='invalid'?2:1,sampleCount:4};}
 const events=[];for await(const event of provider.transcribe({deadlineAt:new Date(1000).toISOString(),now:()=>new Date(now).toISOString()},stream(),controller.signal))events.push(event);
 assert.equal(events.at(-1)?.outcome,mode==='cancel'?'cancelled':mode==='deadline'?'timedOut':'failed');assert.equal(socket.sent.length,1);assert.equal(socket.onmessage,null);
 }
});
