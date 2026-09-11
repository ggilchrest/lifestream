import test from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue } from "../src/runtime/speech-queue.ts";
test("speech queue applies producer backpressure and retains semantic order", async () => {
  const controller = new AbortController(), queue = new SpeechQueue(controller.signal, 1);
  await queue.put("First sentence."); let accepted = false;
  const pending = queue.put("Second sentence.").then(() => { accepted = true; });
  await Promise.resolve(); assert.equal(accepted, false);
  const reader = queue[Symbol.asyncIterator](); assert.equal((await reader.next()).value, "First sentence.");
  await pending; queue.close(); assert.equal((await reader.next()).value, "Second sentence."); assert.equal((await reader.next()).done, true);
});
test("cancellation releases blocked producers and fences queued text", async () => {
  const controller = new AbortController(), queue = new SpeechQueue(controller.signal, 1);
  await queue.put("Old speech."); const pending = queue.put("Late speech."); controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(queue[Symbol.asyncIterator]().next(), /cancelled/);
});
