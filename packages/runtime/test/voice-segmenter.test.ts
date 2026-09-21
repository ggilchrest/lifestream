import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateLatency } from "../src/performance/metrics.ts";
import { SpeechSafeSegmenter, projectSpeech } from "../src/voice/segmenter.ts";

test('first-clause mode releases a substantial natural pause once, retaining every word',()=>{
  const first='The gardener carefully checked the quiet greenhouse before opening the door,';
  const rest=' and found a smooth blue stone beside the oldest rose bush.';
  const segmenter=new SpeechSafeSegmenter(360,{firstClauseMinChars:64});
  assert.deepEqual(segmenter.push(first),[],'a comma needs whitespace lookahead');
  assert.deepEqual(segmenter.push(' '),[{segmentId:'segment-0',sequence:0,text:first}]);
  assert.deepEqual(segmenter.push(rest.trimStart()),[]);
  assert.deepEqual(segmenter.flush().map(s=>s.text),[rest.trim()]);
  const later=new SpeechSafeSegmenter(360,{firstClauseMinChars:64});
  assert.deepEqual(later.push('Hello. '+first+' ').map(s=>s.text),['Hello.'],'later clauses keep sentence grouping');
  later.cancel();assert.deepEqual(later.push(rest),[]);assert.deepEqual(later.flush(),[]);
});

test('first-clause split matrix keeps markup, numbers, addresses and short openings intact',()=>{
  const inputs=[
    'After checking the full inventory and preserving the existing version of every file, do not delete 1,234 records or change 3.14 mg.',
    '<think>A long hidden discussion, with internal instructions, must never be spoken.</think> Dr. Smith says **do not** change the settings of the current installed service, and keep file_name.txt unchanged.',
    'Read [the detailed reference guide, including its examples](https://example.com/reference?q=1,2). Keep the current state.',
    'Here is a deliberately long line of prose before `private, code, details` and {"hidden":"private, value"}, followed by [[CONTROL, SECRET]] visible words.',
    'Yes, I can explain it. The gardener carefully checked the quiet greenhouse before opening the door, and found a stone.'
  ];
  for(const raw of inputs){
    for(let split=0;split<=raw.length;split++){
      const segmenter=new SpeechSafeSegmenter(360,{firstClauseMinChars:64});
      const result=[...segmenter.push(raw.slice(0,split)),...segmenter.push(raw.slice(split)),...segmenter.flush()].map(s=>s.text).join(' ');
      assert.equal(result,projectSpeech(raw),`split ${split}: ${raw}`);
    }
    const segmenter=new SpeechSafeSegmenter(360,{firstClauseMinChars:64});
    const result=[...Array.from(raw).flatMap(c=>segmenter.push(c)),...segmenter.flush()].map(s=>s.text).join(' ');
    assert.equal(result,projectSpeech(raw),`single-character deltas: ${raw}`);
  }
  const short=new SpeechSafeSegmenter(360,{firstClauseMinChars:64});assert.deepEqual(short.push('Yes, I can explain it'),[]);
});

test("segmenter waits for semantic boundary and strips control markup", () => { const segmenter = new SpeechSafeSegmenter(); assert.deepEqual(segmenter.push("Hello [[CAPABILITY_SUCCESS]]"), []); assert.deepEqual(segmenter.push(" world."), []); assert.deepEqual(segmenter.flush(), [{ segmentId: "segment-0", sequence: 0, text: "Hello world." }]); });
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
  assert.deepEqual([...segmenter.push("First sentence. Second sentence."),...segmenter.flush()].map(s => s.text), ["First sentence.", "Second sentence."]);
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
test('formatter split matrix preserves signs, units, paths and comparisons',()=>{
  const cases=[
    ['Keep file_name.txt unchanged. Do not run rm -rf /tmp/a_b.', 'Keep file_name.txt unchanged. Do not run rm -rf /tmp/a_b.'],
    ['Use -5.25 °C, not +4 °C; 2 < 3 and 5 > 4.', 'Use -5.25 °C, not +4 °C; 2 < 3 and 5 > 4.'],
    ['<b>Do not</b> change 12 kg. 👩🏽‍💻 🇨🇦 Keep 1️⃣ item.', 'Do not change 12 kg. Keep 1 item.'],
    ['# Summary\n- **Never** reset it.\nRun `check --read-only` only after approval.', 'Summary Never reset it. Run code shown on screen only after approval.'],
    ['Use _steady_ speech. Follow [this link](https://example.com/file_name?q=3.14).', 'Use steady speech. Follow this link.']
  ];
  for(const [raw,expected] of cases)for(let split=0;split<=raw.length;split++){
    const segmenter=new SpeechSafeSegmenter(4000);
    const spoken=[...segmenter.push(raw.slice(0,split)),...segmenter.push(raw.slice(split)),...segmenter.flush()].map(value=>value.text).join(' ');
    assert.equal(spoken,expected,`split ${split}: ${raw}`);
  }
});
