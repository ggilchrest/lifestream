import assert from "node:assert/strict";
import test from "node:test";
import {VoiceResponseRouter,voiceUnitText} from "../src/voice/response-router.ts";
const header=JSON.stringify({version:"voice-response/1"})+"\n";
const record=(channel:string,text:string)=>JSON.stringify({channel,text})+"\n";
const raw=header+record("speech","The estimate is ~5 °C, not -12.50 °C.")+record("display",'| Year | High |\n|---|---|\n| 2025 | 3*4 |\n\n```txt\n[voice-ignore] literal\n```');
test("every record/UTF-8/marker split produces one canonical answer and no display speech",()=>{
 for(let split=0;split<=raw.length;split++){
  const router=new VoiceResponseRouter(),units=[...router.push(raw.slice(0,split)),...router.push(raw.slice(split)),...router.finish()];
  assert.deepEqual(units.map(u=>u.channel),["speech","display"]);
  let previous: "speech"|"display"|undefined;
  const canonical=units.map(u=>{const s=voiceUnitText(u,previous);previous=u.channel;return s;}).join("");
  assert.equal(canonical,units[0]!.text+"\n\n"+units[1]!.text);assert.doesNotMatch(canonical,/voice-response\/1|"channel":/);
 }
 const router=new VoiceResponseRouter();assert.equal([...Array.from(raw).flatMap(c=>router.push(c)),...router.finish()].length,2);
});
test("first speech releases before final display and EOF; complete final JSON needs no newline",()=>{
 const router=new VoiceResponseRouter();assert.deepEqual(router.push(header+record("speech","Hello.")),[{channel:"speech",text:"Hello."}]);
 assert.deepEqual(router.push('{"channel":"display","text":"Table'),[]);
 assert.deepEqual(router.push(' details"}'),[]);
 assert.deepEqual(router.finish(),[{channel:"display",text:"Table details"}]);
});
test("malformed, partial, unframed, nested and oversized inputs fail closed",()=>{
 for(const bad of ['Hello.',header+'{"channel":"speech","text":"unfinished',header+record('display','Table'),header+record('speech','| A | B |'),header+record('speech','```code```'),header+record('speech','[voice-ignore] hidden'),header+record('speech','Hello.')+record('display','Table')+record('speech','Late.'),header+record('speech','x'.repeat(721)),header+' '.repeat(4097),JSON.stringify({version:'voice-response/2'})+'\n']){
  const router=new VoiceResponseRouter();assert.throws(()=>{router.push(bad);router.finish();});assert.deepEqual(router.push(record('speech','late')),[]);assert.deepEqual(router.finish(),[]);
 }
});
test("wire, unit and text budgets are independent; cancel discards pending and late text",()=>{
 assert.throws(()=>new VoiceResponseRouter().push(' '.repeat(65537)),/wire limit/);
 assert.throws(()=>new VoiceResponseRouter().push(header+record('speech','Hi.')+record('display','x'.repeat(1000)).repeat(17)),/text limit/);
 assert.throws(()=>new VoiceResponseRouter().push(header+record('speech','Hi.').repeat(129)),/text limit/);
 const router=new VoiceResponseRouter();router.push(header+'{"channel":"speech","text":"par');router.cancel();assert.deepEqual(router.push('tial"}\n'),[]);assert.deepEqual(router.finish(),[]);
});
