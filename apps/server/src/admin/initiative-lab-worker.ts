import {parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {Database} from '@lifestream/storage-sqlite';
import {compileRelationshipContext} from '@lifestream/runtime/context';
import {InitiativeHost,type InitiativeSimulationEvent,type InitiativeOwner,type InitiativeSession} from '../runtime/initiative-host.ts';
import {initiativePreset} from './initiative-policy.ts';
import type {HostRuntimeInput} from '../runtime/inference.ts';
import type {InferenceProvider} from '@lifestream/runtime/inference';

const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={assistantId:uid(1),userId:uid(2),relationshipId:uid(3),deploymentId:uid(4)},sessionId=uid(5),endpointId=uid(6);
const start=Date.parse('2000-01-01T00:00:00Z');
// Public synthetic reference sequence; no account evidence or physical observations.
export const initiativeLabSequence=[
 {minute:0,kind:'arrivalReturn',topic:null,context:'privateAvailable'},
 {minute:1,kind:'groundedFollowUp',topic:'topic:lab:1',context:'privateAvailable'},
 {minute:5,kind:'groundedFollowUp',topic:'topic:lab:1',context:'privateAvailable'},
 {minute:10,kind:'groundedFollowUp',topic:'topic:lab:1',context:'privateAvailable'},
 {minute:15,kind:'groundedFollowUp',topic:'topic:lab:2',context:'quiet'},
 {minute:20,kind:'groundedFollowUp',topic:'topic:lab:2',context:'privateAvailable'},
 {minute:25,kind:'groundedFollowUp',topic:'topic:lab:3',context:'shared'},
 {minute:30,kind:'groundedFollowUp',topic:'topic:lab:3',context:'privateAvailable'},
 {minute:35,kind:'groundedFollowUp',topic:'topic:lab:4',context:'privateAvailable'},
 {minute:40,kind:'groundedFollowUp',topic:'topic:lab:5',context:'privateAvailable'},
 {minute:45,kind:'availableCheckIn',topic:null,context:'privateAvailable'},
 {minute:50,kind:'availableCheckIn',topic:null,context:'privateAvailable'}
] as const;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const tuning={openingsPerHour:2,openingsPerDay:8,minimumGapSeconds:1200,checkInIntervalSeconds:1800,arrivalDwellSeconds:10,meaningfulAbsenceSeconds:600,arrivalTtlSeconds:90,checkInTtlSeconds:120,followUpTtlSeconds:300,pendingPerRelationship:4,pendingPerRuntime:16,generationCallsPerOpportunity:1,concurrentSocialCalls:1,generationMaxTokens:160,generationDeadlineSeconds:10,inferenceCallsPerRelationshipHour:12,inferenceCallsPerRuntimeHour:24,automaticRetries:0,dedupRetentionSeconds:86400};
export type InitiativeLabReport={scenarioRevision:string;configurationDigest:string;records:Record<string,unknown>[];explanations:{code:string;summary:string;sourceRefs:string[]}[];variants:{name:string;configurationId:string;openings:number;distinctTopics:number;calls:number;suppressions:number;rows:{minute:number;state:string;stage:string;reasons:string[]}[]}[]};
export async function runInitiativeLab(selected:Record<string,unknown>):Promise<InitiativeLabReport>{
 const report:InitiativeLabReport={scenarioRevision:digest({sequence:initiativeLabSequence,start,seed:1,provider:'initiative-lab-fixture:1'}),configurationDigest:digest(selected),records:[],explanations:[],variants:[]};
 for(const [variantIndex,name]of ['reserved','friendly','highlyEngaged','selected'].entries()){
  let now=start;const db=new Database({path:':memory:'});db.migrate();db.exec('CREATE TABLE assistant_relationship_idempotency (idempotency_key TEXT PRIMARY KEY, relationship_id TEXT NOT NULL, operation TEXT NOT NULL, response_json TEXT NOT NULL)');const events=new Map<string,InitiativeSimulationEvent>(),host=new InitiativeHost(db,{resolve:(_s,_id,id)=>events.get(id)},()=>now);
  const level=[2,5,11,Number(selected.proactiveness)][variantIndex]!,configurationId=uid(100+variantIndex),settings=name==='selected'?structuredClone(selected):{preset:name,proactiveness:level,dimensions:initiativePreset(level),allowedContexts:['privateAvailable'],endpointIds:[endpointId],allowedModalities:['text'],allowedKinds:['arrivalReturn','availableCheckIn','groundedFollowUp'],consentRefs:['consent:lab'],tuning:{...tuning,...(level<4?{openingsPerHour:0,openingsPerDay:0,checkInIntervalSeconds:0}:level===11?{openingsPerHour:8,openingsPerDay:32,minimumGapSeconds:300,checkInIntervalSeconds:300}:{})},adaptation:{enabled:false,maximumDeferralSeconds:0}};
  // Map only the existence of selected permissions into the isolated synthetic realm.
  // A selected speech-only channel cannot become text; the reference sink has no audio.
  if(name==='selected'){settings.endpointIds=(selected.endpointIds as string[]).length?[endpointId]:[];settings.consentRefs=(selected.consentRefs as string[]).length?['consent:lab']:[];}
  const configuration={...settings,...scope,schemaVersion:'1.0.0',recordType:'configuration',configurationId,revision:1,lifecycle:'active',parentConfigurationRevision:`${configurationId}:1`};
  const evidenceRefs=Array.from({length:5},(_,n)=>`topic:lab:${n+1}`),owner:InitiativeOwner={scope,configuration,profile:{assistantId:scope.assistantId,profileId:uid(7),revision:1,status:'active'},boundary:'synthetic-lab:1',consentCurrent:true,evidenceRefs};
  const session:InitiativeSession={sessionId,conversationId:uid(8),revision:1,endpoint:{schemaVersion:'1.0.0',endpointId,endpointClass:'testHarness',locationRef:null,ownership:'fixture',inputModalities:['text'],outputModalities:['text'],privacyClass:'personal',presenceCapabilities:[],rendererCapabilities:null,handoffSupport:'none',speakerIdentity:'unavailable',health:'healthy',configurationRevision:1}};
  let calls=0,emitted:Record<string,unknown>|undefined;const rows:InitiativeLabReport['variants'][number]['rows']=[],topics=new Set<string>();
  const provider:InferenceProvider={async *generate(request){calls++;if(request.sections.at(-1)?.content!=='')throw new Error('Lab opening fabricated user input');yield {kind:'text',text:'Synthetic opening.'};yield {kind:'done'};}};
  const prepare=():HostRuntimeInput=>({assistantId:scope.assistantId,endpointId,isCurrent:()=>true,profileProjection:{sourceRef:'profile:lab',sourceRevision:'profile:1',corePersona:'A neutral synthetic Assistant.',adaptivePersona:'Fixed comparison persona.'},preparedRelationshipContext:compileRelationshipContext({records:evidenceRefs.map(id=>({id,content:`Unfinished synthetic exercise ${id}.`,revision:1,sourceFamily:'synthetic:lab',status:'approved',use:'baseline',personalization:true,mention:true})),userInput:'',audienceScope:'authenticatedSession',profileRevision:'profile:1',relationshipRevision:`${scope.relationshipId}:1`,configurationRevision:`${configurationId}:1`,now}),runtimeSelfContext:{sourceRevision:'runtime:lab:1',runtimeStatus:'ready',endpointId,endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},limitations:['Isolated synthetic sink. No real output or capture.']}});
  const context={owner:()=>owner,session:()=>session,authorized:()=>true,prepare,provider,signal:new AbortController().signal,emit:(prefix:string,suffix:()=>string)=>{emitted=JSON.parse(prefix+suffix());}};
  const command=(body:Record<string,unknown>)=>host.handle({schemaVersion:'1.0.0',sessionId,...body},context);
  try{
   report.records.push(configuration);await command({operation:'outputReadiness',modality:'text',ready:true});
   for(const [index,step]of initiativeLabSequence.entries()){
    now=start+step.minute*60000;const id=uid(1000+index),event:InitiativeSimulationEvent={sourceEventId:id,userId:scope.userId,sessionId,kind:step.kind,topicRef:step.topic,context:step.context,modality:'text',observedAt:now,expiresAt:now+60000,dwellSeconds:10,absenceSeconds:600,unfinishedEvidenceCurrent:step.topic!==null};events.clear();events.set(id,event);emitted=undefined;
    const result=await command({operation:'simulate',idempotencyKey:uid(2000+index),sourceEventId:id,kind:step.kind,topicRef:step.topic});
    // Allow actual iterator settlement before the next virtual event; no guessed refund.
    await new Promise<void>(resolve=>setImmediate(resolve));
    const record=host.ledger.list(scope).find(r=>r.opportunity.sourceRefs.includes(`synthetic-event:${id}`));
    if(result&&result.status>=400){if(result.body.code!=='initiative_admission_denied'||result.body.message!=='Unanswered Initiative topic')throw new Error(`Lab runtime failed: ${String(result.body.code)}`);rows.push({minute:step.minute,state:'notAdmitted',stage:'none',reasons:[String(result.body.message)]});continue;}
    if(!record)throw new Error('Lab runtime returned no outcome');
    if(emitted){const op=record.opportunity;await command({operation:'acknowledge',opportunityId:op.opportunityId,receiptId:record.outcome.deliveryReceiptRef,kind:'endpointAccepted'});topics.add(op.topicKey);}
    const final=host.ledger.get(scope,record.opportunity.opportunityId)!;report.records.push(final.opportunity as unknown as Record<string,unknown>,final.outcome as unknown as Record<string,unknown>);rows.push({minute:step.minute,state:final.outcome.state,stage:final.outcome.lastDeliveryStage,reasons:final.outcome.reasonCodes});
   }
   const openings=host.ledger.list(scope).filter(r=>r.outcome.lastDeliveryStage==='acknowledged').length;
   for(const row of rows)report.explanations.push({code:`initiative_lab_case_${name}_${row.minute}`,summary:`${row.state==='acknowledged'?'Synthetic endpoint accepted':row.state==='notAdmitted'?'Not admitted':row.state==='suppressed'?'Suppressed':row.state}. ${row.reasons.map(reason=>({quiet:'Quiet mode',privacyInsufficient:'Private audience unavailable',contextRestricted:'Configured scope disallows this event',cooldown:'Minimum gap has not elapsed',openingBudget:'Opening ceiling reached',reserved:'Reserved settings allow no social opening',notOptedIn:'No output permission selected',endpointAccepted:'Text accepted by the in-memory sink'} as Record<string,string>)[reason]??reason).join('; ')}. Recorded simulation stage: ${row.stage}.`,sourceRefs:[configurationId]});
   report.variants.push({name,configurationId,openings,distinctTopics:topics.size,calls,suppressions:rows.filter(r=>r.state==='suppressed'||r.state==='notAdmitted').length,rows});
   report.explanations.push({code:`initiative_lab_${name}`,summary:`${name}: ${openings} simulated openings; ${topics.size} distinct topics; ${calls} fixture calls; ${rows.filter(r=>r.state==='suppressed'||r.state==='notAdmitted').length} suppressed or not admitted. Only the isolated in-memory sink accepted output; no speech, physical playback or Human reception is claimed.`,sourceRefs:[configurationId]});
  }finally{host.close();db.close();}
 }
 report.explanations.unshift({code:'initiative_lab_complete',summary:'Completed pinned synthetic comparison. Reference levels 2, 5 and 11 use provisional band tuning and synthetic text permission. Selected settings run separately with their restrictions, mapping only existing endpoint/consent permissions into the Lab. All variants share the same clock, events, evidence, persona and deterministic fixture provider. No live configuration, canonical memory, capture, provider or output was used. This does not qualify selected-model quality, voiced warmth, reserved presentation acknowledgment or physical presence.',sourceRefs:[`scenario:${report.scenarioRevision}`,`selected-settings:${report.configurationDigest}`]});
 return report;
}
if(parentPort)void runInitiativeLab(workerData.settings).then(report=>parentPort!.postMessage({report})).catch(()=>parentPort!.postMessage({error:'Isolated Initiative comparison failed.'}));
