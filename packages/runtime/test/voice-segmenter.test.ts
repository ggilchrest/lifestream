import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateLatency } from "../src/performance/metrics.ts";
import { SpeechSafeSegmenter } from "../src/voice/segmenter.ts";

test("segmenter waits for semantic boundary and strips control markup", () => { const segmenter = new SpeechSafeSegmenter(); assert.deepEqual(segmenter.push("Hello [[CAPABILITY_SUCCESS]]"), []); assert.deepEqual(segmenter.push(" world."), [{ segmentId: "segment-0", sequence: 0, text: "Hello world." }]); });
test("segmenter flushes and cancellation fences late text", () => { const segmenter = new SpeechSafeSegmenter(10); assert.equal(segmenter.push("one two three").length, 1); segmenter.cancel(); assert.deepEqual(segmenter.push("late."), []); assert.deepEqual(segmenter.flush(), []); });
test("all incremental splits preserve words, decimals, negation and suppress markup", () => {
  const raw = "Dr. Smith says **do not** use 3.14 mg. Read [the guide](https://example.com/a). [[PRIVATE_CONTROL]] Stay calm 😊.";
  const expected = "Dr. Smith says do not use 3.14 mg. Read the guide. Stay calm .";
  for (let split = 0; split <= raw.length; split++) {
    const segmenter = new SpeechSafeSegmenter(4000);
    const result = [...segmenter.push(raw.slice(0, split)), ...segmenter.push(raw.slice(split)), ...segmenter.flush()];
    assert.equal(result.map(value => value.text).join(" "), expected, `split ${split}`);
  }
});
test("complete input emits individual sentences and incomplete controls never leak", () => {
  const segmenter = new SpeechSafeSegmenter();
  assert.deepEqual(segmenter.push("First sentence. Second sentence.").map(s => s.text), ["First sentence.", "Second sentence."]);
  assert.deepEqual(segmenter.push(" [[private. unfinished"), []);
  assert.deepEqual(segmenter.flush(), []);
});
test("latency metrics use actual playback sample and one clock", () => { const milestones = [{ name: "turn.commit", clockId: "virtual", reading: 10 }, { name: "inference.first-token", clockId: "virtual", reading: 20 }, { name: "segment.first", clockId: "virtual", reading: 25 }, { name: "tts.first-audio", clockId: "virtual", reading: 30 }, { name: "playback.first-sample", clockId: "virtual", reading: 40 }]; assert.deepEqual(calculateLatency(milestones), { ttft: 10, ttfsw: 30, firstSegment: 15 }); assert.throws(() => calculateLatency([...milestones, { name: "x", clockId: "wall", reading: 1 }]), /clock/); });
test('hidden reasoning stays suppressed at every delta split',()=>{
  const text='Hello. <think>Never speak this. Nor this! Another private thought.</think> Keep 3.14 mg, not 4 mg.';
  for(let split=0;split<=text.length;split++){
    const segmenter=new SpeechSafeSegmenter();
    const spoken=[...segmenter.push(text.slice(0,split)),...segmenter.push(text.slice(split)),...segmenter.flush()].map(value=>value.text).join(' ');
    assert.equal(spoken,'Hello. Keep 3.14 mg, not 4 mg.',`split ${split}`);
  }
});
test('raw structured envelopes and code are visual, never spoken control strings',()=>{
  for(const text of ['Here are details. {"tool":"internal. payload!","arguments":{"secret":true}} Do not run it.', 'Here are details. ```js\nrun("private. command");\n``` Do not run it.']){
    for(let split=0;split<=text.length;split++){
      const segmenter=new SpeechSafeSegmenter(4000);
      const spoken=[...segmenter.push(text.slice(0,split)),...segmenter.push(text.slice(split)),...segmenter.flush()].map(value=>value.text).join(' ');
      assert.doesNotMatch(spoken,/internal|payload|secret|private|command/);
      assert.match(spoken,/shown on screen/);assert.match(spoken,/Do not run it\.$/);
    }
  }
});
