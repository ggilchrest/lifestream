import assert from "node:assert/strict"; import { test } from "node:test"; import { FixtureInferenceProvider } from "../src/inference/fixture.ts"; import { buildCanonicalPrompt } from "../src/inference/prompt.ts";
const context = { signal: new AbortController().signal };
test("voice instructions extend only trusted policy and remain reflected in the manifest",()=>{
  const input={assistantId:"a",sessionId:"s",interactionId:"i",endpointId:null,userInput:"Keep numbers and uncertainty."};
  const typed=buildCanonicalPrompt(input),voice=buildCanonicalPrompt({...input,voiceMode:true});
  assert.deepEqual(voice.sections.slice(1),typed.sections.slice(1));
  assert.equal(voice.sections[0].trusted,true);assert.match(voice.sections[0].content,/spoken conversation/);
  assert.notEqual(voice.sections[0].contentDigest,typed.sections[0].contentDigest);
  assert.equal(voice.manifest.sections[0].contentDigest,voice.sections[0].contentDigest);
  assert.equal(voice.manifest.sections[0].sourceRef,"policy:spoken-v1");
});
test("fixture inference has deterministic section output", async () => { const request = buildCanonicalPrompt({ assistantId: "a", sessionId: "s", interactionId: "i", endpointId: null, userInput: "hello" }); const a = []; for await (const c of new FixtureInferenceProvider().generate(request, context)) a.push(c); assert.equal(a[0].text, "Fixture response: hello"); assert.deepEqual(request.sections.map((section) => section.kind), ["policy", "corePersona", "adaptivePersona", "interactionState", "preparedMemory", "worldContext", "capabilityState", "conversation", "userInput"]); assert.equal(request.manifest.sections.length, 9); });
test("replay fixture inference produces no live output", async () => { const request = buildCanonicalPrompt({ assistantId: "a", sessionId: "s", interactionId: "i", endpointId: null, userInput: "hello", executionMode: "replay" }); const chunks = []; for await (const chunk of new FixtureInferenceProvider().generate(request, context)) chunks.push(chunk); assert.deepEqual(chunks, []); });
