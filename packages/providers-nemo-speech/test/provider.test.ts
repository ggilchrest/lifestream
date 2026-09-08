import assert from "node:assert/strict";
import { test } from "node:test";
import { NemoSpeechProvider } from "../src/provider.ts";

const format = { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const };
const audio = async function* () { yield { type: "frame" as const, audioInputId: "input-1", frame: { frameId: "frame-1", sequence: 0, format, sampleOffset: 0, sampleCount: 4, dataBase64: "AAAAAAAAAAA=" } }; yield { type: "end" as const, audioInputId: "input-1", nextSequence: 1, sampleCount: 4 }; };

class FakeSocket {
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null; sent: (string | ArrayBuffer)[] = [];
  send(data: string | ArrayBuffer): void { this.sent.push(data); if (typeof data === "string" && data.includes("input_audio_buffer.commit")) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "hello" }) })); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", text: "hello." }) })); } }
  close(): void { this.onclose?.(); }
}

test("NeMo adapter maps realtime partial and committed events without claiming turn authority", async () => {
  const socket = new FakeSocket();
  const provider = new NemoSpeechProvider({ baseUrl: "http://127.0.0.1:8080", model: "nemotron-en", webSocketFactory: () => { queueMicrotask(() => socket.onopen?.()); return socket; } });
  const events = []; for await (const event of provider.transcribe({ deadlineAt: "2026-09-08T00:01:00Z", now: () => "2026-09-08T00:00:00Z" }, audio())) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), ["data", "data", "terminal"]);
  assert.equal(events[0]?.payload.type, "partial"); assert.equal(events[1]?.payload.type, "committed"); assert.equal(events.at(-1)?.outcome, "succeeded");
  assert.equal(typeof socket.sent[0], "string"); assert.match(String(socket.sent[0]), /session\.update/); assert.equal(socket.sent.length, 3);
});

test("NeMo adapter fences cancellation and rejects non-16k or non-contiguous PCM before transport", async () => {
  let opened = false; const socket = new FakeSocket(); const provider = new NemoSpeechProvider({ baseUrl: "http://127.0.0.1:8080", model: "nemotron-en", webSocketFactory: () => { opened = true; queueMicrotask(() => socket.onopen?.()); return socket; } });
  const controller = new AbortController(); controller.abort(); const cancelled = []; for await (const event of provider.transcribe({ deadlineAt: "2026-09-08T00:01:00Z", now: () => "2026-09-08T00:00:00Z" }, audio(), controller.signal)) cancelled.push(event); assert.equal(cancelled.at(-1)?.outcome, "cancelled"); assert.equal(opened, false);
  const invalidSocket = new FakeSocket(); const invalidProvider = new NemoSpeechProvider({ baseUrl: "http://127.0.0.1:8080", model: "nemotron-en", webSocketFactory: () => { queueMicrotask(() => invalidSocket.onopen?.()); return invalidSocket; } });
  const invalid = async function* () { yield { type: "frame" as const, audioInputId: "bad", frame: { frameId: "f", sequence: 1, format, sampleOffset: 0, sampleCount: 4, dataBase64: "AAAAAAAAAAA=" } }; };
  const rejected = []; for await (const event of invalidProvider.transcribe({ deadlineAt: "2026-09-08T00:01:00Z", now: () => "2026-09-08T00:00:00Z" }, invalid())) rejected.push(event); assert.equal(rejected.at(-1)?.outcome, "failed"); assert.equal(invalidSocket.sent.length, 1); assert.match(String(invalidSocket.sent[0]), /session\.update/);
});
