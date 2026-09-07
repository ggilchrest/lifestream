import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAudioFrame, validateSttInput, validateTerminalSequence, type AudioFormat, type SttInput } from "../src/voice/ports.ts";

const format: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };
const frame = (sequence: number) => ({ frameId: `frame-${sequence}`, sequence, format, sampleOffset: sequence * 10, sampleCount: 10, dataBase64: "AAAA" });
async function* stream(items: SttInput[]): AsyncIterable<SttInput> { yield* items; }

test("STT input enforces explicit format, ordering, and terminal counts", async () => { assert.deepEqual(await validateSttInput(stream([{ type: "frame", audioInputId: "audio", frame: frame(0) }, { type: "end", audioInputId: "audio", nextSequence: 1, sampleCount: 10 }]), format), { frames: 1, samples: 10 }); await assert.rejects(validateSttInput(stream([{ type: "frame", audioInputId: "audio", frame: { ...frame(1), sequence: 1 } }, { type: "end", audioInputId: "audio", nextSequence: 2, sampleCount: 10 }]), format), /sequence/); });
test("format drift, missing end, and malformed frames fail closed", async () => { assert.throws(() => validateAudioFrame({ ...frame(0), format: { ...format, channels: 2 } }, format), /format/); await assert.rejects(validateSttInput(stream([{ type: "frame", audioInputId: "audio", frame: frame(0) }]), format), /missing end/); assert.throws(() => validateTerminalSequence([{ kind: "data", sequence: 0, payload: { type: "partial", utteranceId: "u", text: "x", startSample: 0, endSample: 1, speakerRef: null, confidence: 1 } }]), /terminal/); });
