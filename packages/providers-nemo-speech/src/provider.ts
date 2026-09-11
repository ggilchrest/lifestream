type AudioFormat = { encoding: "pcm_s16le"; sampleRateHz: 16000 | 24000 | 48000; channels: 1 | 2 };
type AudioFrame = { frameId: string; sequence: number; format: AudioFormat; sampleOffset: number; sampleCount: number; dataBase64: string };
type SttInput = { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "end"; audioInputId: string; nextSequence: number; sampleCount: number };
type SpeechRequest = { deadlineAt: string; now: () => string };
type SttData = { type: "partial" | "committed"; utteranceId: string; text: string; startSample: number; endSample: number; speakerRef: string | null; confidence: number };
type SttEvent = { kind: "data"; sequence: number; payload: SttData } | { kind: "terminal"; sequence: number; outcome: "succeeded" | "rejected" | "cancelled" | "timedOut" | "failed"; inputSamples: number };
type SpeechToTextProvider = { transcribe(request: SpeechRequest, audio: AsyncIterable<SttInput>, signal?: AbortSignal): AsyncIterable<SttEvent> };

type NemoMessage = { type?: string; text?: string; transcript?: string; delta?: string; error?: { message?: string } };
type NemoSocket = { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null; onclose: (() => void) | null; send(data: string | ArrayBuffer): void; close(): void };
type NemoSocketFactory = (url: string) => NemoSocket;

export type NemoSpeechOptions = {
  baseUrl: string;
  model: string;
  language?: string;
  endpointingMs?: number;
  webSocketFactory: NemoSocketFactory;
};

const EXPECTED_RATE = 16000;
const MAX_FRAME_SAMPLES = 4800;
const MAX_PENDING_MESSAGES = 64;

function validateInput(item: SttInput, expectedId: string | undefined, expectedSequence: number, expectedSamples: number): void {
  if (expectedId !== undefined && item.audioInputId !== expectedId) throw new Error("audio input identity changed");
  if (item.type === "frame") {
    const { frame } = item;
    if (frame.sequence !== expectedSequence || frame.sampleOffset !== expectedSamples || frame.format.encoding !== "pcm_s16le" || frame.format.sampleRateHz !== EXPECTED_RATE || frame.format.channels !== 1 || frame.sampleCount < 1 || frame.sampleCount > MAX_FRAME_SAMPLES) throw new Error("audio frame invalid");
    const bytes = Buffer.from(frame.dataBase64, "base64");
    if (bytes.length !== frame.sampleCount * 2) throw new Error("audio frame byte count invalid");
  } else if (item.nextSequence !== expectedSequence || item.sampleCount !== expectedSamples) throw new Error("audio end count mismatch");
}

function socketUrl(baseUrl: string): string { return `${baseUrl.replace(/^http/, "ws")}/v1/realtime`; }

export class NemoSpeechProvider implements SpeechToTextProvider {
  private readonly options: NemoSpeechOptions;
  constructor(options: NemoSpeechOptions) { this.options = options; }

  async *transcribe(request: SpeechRequest, audio: AsyncIterable<SttInput>, signal?: AbortSignal): AsyncIterable<SttEvent> {
    let inputId: string | undefined;
    let nextSequence = 0;
    let inputSamples = 0;
    let eventSequence = 0;
    let committed = false;
    let ended = false;
    const queue: NemoMessage[] = [];
    let wake: (() => void) | undefined;
    let socket: NemoSocket | undefined;
    let socketClosed = false;
    let timedOut = false;
    let rejectOpen: ((error: Error) => void) | undefined;
    const stop = (): void => {
      socketClosed=true;
      try { socket?.close(); } catch { /* Connecting transport can already be closed. */ }
      rejectOpen?.(new Error("speech transport stopped"));wake?.();wake=undefined;
    };
    const remainingMs=Date.parse(request.deadlineAt)-Date.parse(request.now());
    const timer=setTimeout(()=>{timedOut=true;stop();},Math.max(1,Math.min(2_147_483_647,remainingMs)));
    signal?.addEventListener("abort",stop,{once:true});
    const push = (message: NemoMessage): void => {
      if (queue.length >= MAX_PENDING_MESSAGES) { socket?.close(); return; }
      queue.push(message); wake?.(); wake = undefined;
    };
    const fail = (): void => { socketClosed = true; push({ type: "error" }); };
    try {
      if (Date.parse(request.now()) >= Date.parse(request.deadlineAt)) { yield { kind: "terminal", sequence: eventSequence, outcome: "timedOut", inputSamples }; return; }
      if (signal?.aborted) { yield { kind: "terminal", sequence: eventSequence, outcome: "cancelled", inputSamples }; return; }
      socket = this.options.webSocketFactory(socketUrl(this.options.baseUrl));
      socket.onmessage = (event) => { try { push(JSON.parse(event.data) as NemoMessage); } catch { fail(); } };
      socket.onerror = fail;
      socket.onclose = () => { socketClosed = true; rejectOpen?.(new Error("provider closed before opening"));wake?.(); wake = undefined; };
      await new Promise<void>((resolve, reject) => { rejectOpen=reject;socket!.onopen = resolve; const originalError = socket!.onerror; socket!.onerror = () => { originalError?.(); reject(new Error("provider unavailable")); }; });
      rejectOpen=undefined;
      if(signal?.aborted||timedOut)throw new Error("speech transport stopped");
      socket.send(JSON.stringify({ type: "session.update", session: { sample_rate: EXPECTED_RATE, language: this.options.language ?? "en-US", endpointing_ms: this.options.endpointingMs ?? 1200 } }));
      for await (const item of audio) {
        if (signal?.aborted) { socket.close(); yield { kind: "terminal", sequence: eventSequence, outcome: "cancelled", inputSamples }; return; }
        if (Date.parse(request.now()) >= Date.parse(request.deadlineAt)) { socket.close(); yield { kind: "terminal", sequence: eventSequence, outcome: "timedOut", inputSamples }; return; }
        inputId ??= item.audioInputId;
        validateInput(item, inputId, nextSequence, inputSamples);
        if (item.type === "frame") { const bytes = Buffer.from(item.frame.dataBase64, "base64"); socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); nextSequence += 1; inputSamples += item.frame.sampleCount; }
        else { socket.send(JSON.stringify({ type: "input_audio_buffer.commit" })); ended = true; break; }
      }
      if (!ended) throw new Error("audio stream missing end");
      while (!committed) {
        if (signal?.aborted) { socket.close(); yield { kind: "terminal", sequence: eventSequence, outcome: "cancelled", inputSamples }; return; }
        if (socketClosed && queue.length === 0) throw new Error("provider stream closed");
        const message = queue.shift() ?? await new Promise<NemoMessage>((resolve) => { wake = () => resolve(queue.shift() ?? { type: "error" }); });
        if(signal?.aborted||timedOut)throw new Error("speech transport stopped");
        if (message.type === "conversation.item.input_audio_transcription.delta") {
          yield { kind: "data", sequence: eventSequence++, payload: { type: "partial", utteranceId: `${inputId ?? "audio"}:${eventSequence}`, text: message.delta ?? message.text ?? "", startSample: 0, endSample: inputSamples, speakerRef: null, confidence: 0 } };
        } else if (message.type === "conversation.item.input_audio_transcription.completed") {
          committed = true;
          yield { kind: "data", sequence: eventSequence++, payload: { type: "committed", utteranceId: `${inputId ?? "audio"}:${eventSequence}`, text: message.transcript ?? message.text ?? "", startSample: 0, endSample: inputSamples, speakerRef: null, confidence: 1 } };
        } else if (message.type === "error") throw new Error(message.error?.message ? "provider error" : "provider error");
      }
      socket.close();
      yield { kind: "terminal", sequence: eventSequence, outcome: "succeeded", inputSamples };
    } catch {
      socket?.close();
      yield { kind: "terminal", sequence: eventSequence, outcome: signal?.aborted ? "cancelled" : timedOut ? "timedOut" : "failed", inputSamples };
    } finally {
      clearTimeout(timer);signal?.removeEventListener("abort",stop);rejectOpen=undefined;wake=undefined;
      if(socket){socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null;try{socket.close();}catch{ /* Already closed. */ }}
      queue.length=0;
    }
  }
}
