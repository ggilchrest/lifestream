import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InitiativeCandidateGenerator, type InitiativeGenerationInput } from "../src/runtime/initiative.ts";
import { Database, InitiativeDeliveryRepository, type InitiativeOpportunity } from "@lifestream/storage-sqlite";
import { compileRelationshipContext } from "@lifestream/runtime/context";
import { buildCanonicalPrompt } from "@lifestream/runtime/inference/prompt";
import type { InferenceProvider, InferenceRequest } from "@lifestream/runtime/inference";

function setup(){
 const id=()=>randomUUID(),now=Date.now();
 const opportunity:InitiativeOpportunity={schemaVersion:"1.0.0",recordType:"opportunity",assistantId:id(),userId:id(),relationshipId:id(),deploymentId:id(),opportunityId:id(),correlationId:id(),conversationId:id(),sessionId:id(),endpointId:id(),configurationId:id(),configurationRevision:1,policyRevision:"policy:synthetic",kind:"availableCheckIn",category:"social",urgency:"low",sourceKind:"runtimeContext",sourceRefs:["synthetic:available-window"],executionMode:"simulation",observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),topicKey:id(),dedupKey:id()};
 const view=compileRelationshipContext({records:[],userInput:"",audienceScope:"authenticatedSession",profileRevision:"profile:1",relationshipRevision:`${opportunity.relationshipId}:1`,configurationRevision:`${opportunity.configurationId}:1`});
 const input:InitiativeGenerationInput={opportunity,interactionId:id(),dimensions:{initiative:11,warmth:10,curiosity:9,followThrough:9,persistence:4},maximumOutputTokens:160,deadlineMs:10000,conversation:"Synthetic existing conversation; no new user message.",voiceMode:false,signal:new AbortController().signal,admit:()=>true,prepared:{assistantId:opportunity.assistantId,endpointId:opportunity.endpointId,isCurrent:()=>true,profileProjection:{sourceRef:"profile:synthetic",sourceRevision:"profile:1",corePersona:"A synthetic user-authored Assistant.",adaptivePersona:"No changes."},preparedRelationshipContext:view,runtimeSelfContext:{sourceRevision:"runtime:1",runtimeStatus:"ready",endpointId:opportunity.endpointId,endpointScope:"sessionEndpoint",audienceScope:"authenticatedSession",permissionState:"authenticatedSession",inputModalities:{text:"active",microphone:"inactive",visual:"notConfigured"},outputModalities:{text:"active",speechGeneration:"unavailable",speechDelivery:"notObserved",presentation:"notConfigured"},limitations:["Synthetic logical endpoint; no physical presence or capture."]}}};
 return input;
}
const good:InferenceProvider={async *generate(){yield {kind:"text",text:"Hello. It’s good to see you."};yield {kind:"done"};}};
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));

test("Initiative generation joins the durable one-call gate to the shared scoped prompt with no user input",async()=>{
 const input=setup(),db=new Database({path:":memory:"});db.migrate();const ledger=new InitiativeDeliveryRepository(db),generator=new InitiativeCandidateGenerator();
 try{
  let row=ledger.admit(input.opportunity,input.opportunity,()=>true),calls=0,request:InferenceRequest|undefined;
  input.admit=()=>{row=ledger.transition(input.opportunity,input.opportunity.opportunityId,row.version,{type:"eligible"});return true;};
  const provider:InferenceProvider={async *generate(r){calls++;request=r;yield {kind:"text",text:"Hello. It’s good to see you."};yield {kind:"done"};}};
  const candidate=await generator.generate(provider,input);assert.equal(candidate.status,"generated");
  assert.equal(request?.sections.at(-1)?.kind,"userInput");assert.equal(request?.sections.at(-1)?.content,"");assert.equal(request?.scope.sessionId,input.opportunity.sessionId);assert.equal(request?.scope.assistantId,input.opportunity.assistantId);
  assert.equal(request?.maximumOutputTokens,160);assert.match(request!.sections.find(s=>s.kind==="interactionState")!.content,/input.microphone=inactive/u);assert.match(request!.sections.find(s=>s.kind==="interactionState")!.content,/"initiative":11/u);
  const reactive=buildCanonicalPrompt({assistantId:input.opportunity.assistantId,sessionId:input.opportunity.sessionId,interactionId:randomUUID(),endpointId:input.opportunity.endpointId,userInput:"hello",preparedRelationshipContext:input.prepared.preparedRelationshipContext,profileProjection:input.prepared.profileProjection});
  assert.deepEqual(request!.sections.find(s=>s.kind==="preparedMemory"),reactive.sections.find(s=>s.kind==="preparedMemory"));assert.deepEqual(request!.sections.find(s=>s.kind==="corePersona"),reactive.sections.find(s=>s.kind==="corePersona"));
  row=ledger.transition(input.opportunity,input.opportunity.opportunityId,row.version,{type:"generated",preparedViewId:randomUUID(),interactionId:input.interactionId});assert.equal(row.outcome.lastDeliveryStage,"generated");assert.equal(row.budget,"none");
  await settle();await assert.rejects(generator.generate(provider,input),/transition/u);assert.equal(calls,1);assert.equal(ledger.get(input.opportunity,input.opportunity.opportunityId)!.outcome.state,"generated");
 }finally{db.close();}
});

test("Initiative generation rejects scope, privacy, replay, expiry and durable-admission failures before provider calls",async()=>{
 const changes:Array<(x:InitiativeGenerationInput)=>void>=[x=>{x.prepared.assistantId=randomUUID();},x=>{x.prepared.endpointId=randomUUID();},x=>{x.prepared.runtimeSelfContext.audienceScope="unknown";},x=>{x.prepared.preparedRelationshipContext!.relationshipRevision=`${randomUUID()}:1`;},x=>{x.prepared.preparedRelationshipContext!.configurationRevision="stale:2";},x=>{x.opportunity.executionMode="replay";},x=>{x.opportunity.expiresAt=new Date(Date.now()-1).toISOString();},x=>{x.maximumOutputTokens=257;},x=>{x.deadlineMs=16000;},x=>{Object.assign(x.prepared.preparedRelationshipContext!,{freshUntil:new Date(Date.now()-1).toISOString()});},x=>{x.admit=()=>false;},x=>{x.prepared.isCurrent=()=>false;},x=>{delete x.prepared.profileProjection;}];
 let calls=0;const provider:InferenceProvider={async *generate(){calls++;yield {kind:"done"};}};
 for(const change of changes){const input=setup();change(input);await assert.rejects(new InitiativeCandidateGenerator().generate(provider,input));}assert.equal(calls,0);
});

test("Initiative generation refuses incomplete, over-budget, tool and post-terminal output; empty completion is noCandidate",async()=>{
 for(const mode of ["incomplete","tooLong","tool","error","afterDone"]){const provider:InferenceProvider={async *generate(){if(mode==="tool"){yield {kind:"capabilityRequest",capability:{name:"fetch",input:{},effect:"read-only"}};return;}if(mode==="error"){yield {kind:"error",error:{code:"failed",message:"failed"}};return;}yield {kind:"text",text:mode==="tooLong"?"x".repeat(161):"Hello."};if(mode!=="incomplete")yield {kind:"done"};if(mode==="afterDone")yield {kind:"text",text:"late"};}};await assert.rejects(new InitiativeCandidateGenerator().generate(provider,setup()),undefined,mode);}
 const result=await new InitiativeCandidateGenerator().generate({async *generate(){yield {kind:"done"};}},setup());assert.equal(result.status,"noCandidate");assert.equal(result.outputBytes,0);
});

test("Initiative cancellation returns promptly but an uncooperative provider retains the social slot until settlement",async()=>{
 const input=setup(),controller=new AbortController();input.signal=controller.signal;const generator=new InitiativeCandidateGenerator();let release:()=>void=()=>{},entered:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;});
 const provider:InferenceProvider={async *generate(){entered();await new Promise<void>(r=>{release=r;});yield {kind:"text",text:"late"};yield {kind:"done"};}};
 const result=generator.generate(provider,input);await started;controller.abort();await assert.rejects(result,/cancelled/u);assert.equal(generator.active,true);await assert.rejects(generator.generate(good,setup()),/occupied/u);
 release();await settle();assert.equal(generator.active,false);assert.equal((await generator.generate(good,setup())).status,"generated");
});

test("Initiative deadline and changed owner boundaries discard partial candidates",async()=>{
 const input=setup();input.deadlineMs=1000;const generator=new InitiativeCandidateGenerator();let release:()=>void=()=>{};
 const provider:InferenceProvider={async *generate(){yield {kind:"text",text:"partial"};await new Promise<void>(r=>{release=r;});yield {kind:"done"};}};
 try{await assert.rejects(generator.generate(provider,input),/timed out/u);assert.equal(generator.active,true);}finally{release();await settle();}
 const changed=setup();let current=true;changed.prepared.isCurrent=()=>current;
 const revoking:InferenceProvider={async *generate(){yield {kind:"text",text:"partial"};current=false;yield {kind:"done"};}};
 await assert.rejects(new InitiativeCandidateGenerator().generate(revoking,changed),/context changed/u);
 const cancelBefore=setup(),cancelController=new AbortController();cancelBefore.signal=cancelController.signal;cancelBefore.prepared.onInferenceRequest=()=>cancelController.abort();await assert.rejects(new InitiativeCandidateGenerator().generate(good,cancelBefore),/context changed/u);
 let calls=0;const before=setup();before.prepared.onInferenceRequest=()=>{before.prepared.isCurrent=()=>false;};await assert.rejects(new InitiativeCandidateGenerator().generate({async *generate(){calls++;yield {kind:"done"};}},before),/context changed/u);assert.equal(calls,0);
});

test("Initiative-only prompt policy cannot be smuggled into a user turn and does not alter reactive prompts",()=>{
 const base={assistantId:randomUUID(),sessionId:randomUUID(),interactionId:randomUUID(),endpointId:randomUUID()},input=setup(),initiative={...input.dimensions,opportunityId:input.opportunity.opportunityId,kind:input.opportunity.kind};
 assert.throws(()=>buildCanonicalPrompt({...base,userInput:"hello",initiative}),/Invalid host/u);
 assert.throws(()=>buildCanonicalPrompt({...base,origin:"relationalOpportunity",userInput:"invented human utterance",initiative}),/fabricate/u);
 assert.throws(()=>buildCanonicalPrompt({...base,origin:"relationalOpportunity",initiative:{...initiative,warmth:12}}),/Invalid host/u);
 const reactive=buildCanonicalPrompt({...base,userInput:"hello"});assert.equal(reactive.sections.at(-1)?.content,"hello");assert.equal(reactive.sections[0]?.sourceRef,"policy:v1");assert.doesNotMatch(reactive.sections[0]!.content,/low-urgency social opening/u);
});
