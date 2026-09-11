import assert from "node:assert/strict";
import test from "node:test";
import { defaultVoiceSettings, parseVoiceSettings } from "../src/runtime/voice-settings.ts";
test("voice test settings are closed, bounded and detached from caller changes", () => {
  assert.deepEqual(parseVoiceSettings(undefined),defaultVoiceSettings);
  const draft={description:"An adult woman, calm and conversational",pace:0.2,energy:0.4,seed:42,deliveryMode:"neutral"};
  const applied=parseVoiceSettings(draft); draft.description="changed"; assert.notEqual(applied.description,draft.description);
  assert.throws(()=>parseVoiceSettings(JSON.parse('{"__proto__":{}}')), /Unknown voice setting/);
  for(const value of [{seed:-1},{seed:NaN},{pace:2},{energy:"0.5"},{deliveryMode:"random"},{description:"(speak this)"},{extra:true}]) assert.throws(()=>parseVoiceSettings(value));
});
test("voice reference requires permission and bounded valid PCM, not a URL or path", () => {
  const reference={sampleRateHz:16000,dataBase64:Buffer.alloc(64000).toString("base64"),transcript:"A reference sentence",consent:true};
  const settings=parseVoiceSettings({reference}); assert.equal(settings.reference?.transcript,reference.transcript);
  reference.transcript="changed";assert.notEqual(settings.reference?.transcript,reference.transcript);
  for(const ref of [{...reference,consent:false},{...reference,sampleRateHz:48000},{...reference,dataBase64:"broken"},{...reference,path:"/etc/passwd"},{...reference,dataBase64:Buffer.alloc(640002).toString("base64")}]) assert.throws(()=>parseVoiceSettings({reference:ref}));
});
