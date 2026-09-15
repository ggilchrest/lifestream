import {parentPort,workerData} from 'node:worker_threads';
import {Database,UnderstandingRepository,understandingDigest,type UnderstandingRecord} from '@lifestream/storage-sqlite';
import {compileRelationshipContext,relationshipControlDefaults,type RelationshipContextRecord} from '@lifestream/runtime/context';
import {buildCanonicalPrompt} from '@lifestream/runtime/inference/prompt';
import {compileDiscoveryCandidates} from './discovery-candidates.ts';
import {selectDiscoveryContext,appendDiscoveryContext} from './discovery-selection.ts';
import type {RelationshipConfiguration} from '../relationship-extensions.ts';

const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={assistantId:uid(1),userId:uid(2),relationshipId:uid(3),deploymentId:uid(4)};
const policy='policy:discovery-lab-v1';
// Independently authored public synthetic data. No account evidence is supplied to this worker.
const facts=[
 {topic:'topic:forest-chronicle',text:'Orin and Vale explore Forest Chronicle. FOREST_DETAIL_281.'},
 {topic:'topic:stellar-saga',text:'Orin and Vale pilot ships in Stellar Saga. STELLAR_DETAIL_392.'},
 {topic:'topic:basalt',text:'This synthetic basalt sample has a fine-grained texture. BASALT_DETAIL_573.'}
];
const scenarios=[
 {id:'ambiguous-pair',split:'comparison',prompt:'Tell me about Orin and Vale.',required:['FOREST_DETAIL_281'],forbidden:['STELLAR_DETAIL_392'],note:'Explicit favorite should constrain an otherwise ambiguous reference; activity is not preference.'},
 {id:'current-domain',split:'comparison',prompt:'Tell me about Orin and Vale in Stellar Saga.',required:['STELLAR_DETAIL_392'],forbidden:['FOREST_DETAIL_281'],note:'Current explicit domain takes precedence over the favorite.'},
 {id:'current-correction',split:'comparison',prompt:'Actually, not Forest Chronicle. Please discuss something else.',required:[],forbidden:['FOREST_DETAIL_281','STELLAR_DETAIL_392'],note:'Current correction withholds optional stale priors immediately.'},
 {id:'source-detail',split:'comparison',prompt:'Tell me more about Forest Chronicle.',required:['FOREST_DETAIL_281'],forbidden:['STELLAR_DETAIL_392'],note:'Source attribution is optional contextual material, never an established personal motive.'},
 {id:'heldout-alternate',split:'heldOut',prompt:'Who pilots ships in Stellar Saga?',required:['STELLAR_DETAIL_392'],forbidden:['FOREST_DETAIL_281'],note:'Frozen alternate wording; no tuning or memory reinforcement occurs in the comparison.'},
 {id:'heldout-mineral',split:'heldOut',prompt:'Describe the basalt sample.',required:['BASALT_DETAIL_573'],forbidden:['FOREST_DETAIL_281','STELLAR_DETAIL_392'],note:'Independent non-game source family and prompt, using the same selector.'}
];
export type DiscoveryLabRow={id:string;split:string;variant:string;prompt:string;note:string;memory:string;manifestDigest:string;sourceRefs:string[];disposition:string;selectedItems:number;tokenUpperBound:number;elapsedMs:number;checks:{name:string;pass:boolean}[]};
export type DiscoveryLabReport={scenarioRevision:string;configurationDigest:string;rows:DiscoveryLabRow[];canonicalRequestCount:number;providerCalls:0};
export function runDiscoveryInputLab(configuration:RelationshipConfiguration):DiscoveryLabReport {
 const database=new Database({path:':memory:'});database.migrate();const now=Date.now(),boundary=understandingDigest('discovery-input-lab-v1'),repository=new UnderstandingRepository(database,()=>now);
 const selected=configuration.extensions!.understanding! as {enabled:boolean;policyRefs:string[];excludedSourceRefs:string[];excludedTopicRefs:string[];budget:Record<string,number>};
 const budget={...selected.budget,jobsPerDay:8,pendingJobsPerRuntime:16};
 try {
  for(const [index,fact]of facts.entries()){
   const source=`source:discovery-lab:${index+1}`,brief:UnderstandingRecord={...scope,schemaVersion:'1.0.0',recordType:'topicBrief',briefId:uid(100+index),revision:1,topicRef:fact.topic,derived:true,status:'prepared',sources:[{sourceRef:source,sourceFamily:`family:lab:${index+1}`,sourceRevision:'revision:1',policyRef:policy,retrievedAt:new Date(now).toISOString(),reliability:'unknown',reliabilityBasis:'Synthetic authored assertion; no independent corroboration.',kind:'providedFixture'}],claims:[{claimId:uid(200+index),text:fact.text,sourceRefs:[source],qualifier:'attributed',versionScope:'Synthetic edition 1',spoilerClass:'none',contradictionRefs:[]}],aliasClaims:[],knowledgeGaps:['Fictional data; no factual-world or personal-motive assertion.'],deeperMaterialRefs:[],builtAt:new Date(now).toISOString(),freshUntil:new Date(now+3600000).toISOString(),compilerRef:'discovery-lab-sources:1',dependencyRefs:[`source:${source}:revision:1`],configurationRef:'configuration:lab:1'};
   const work:UnderstandingRecord={...scope,schemaVersion:'1.0.0',recordType:'work',workId:uid(300+index),revision:1,topicRef:fact.topic,purpose:'briefRebuild',state:'queued',executionMode:'simulation',idempotencyKey:`lab:${index}`,configurationRef:'configuration:lab:1',policyRefs:[policy],dependencyRefs:brief.dependencyRefs,capabilityInvocationRef:null,admissionReceiptRef:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+120000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),budget,producedRefs:[],lastOutcome:'notRun',reason:'Isolated synthetic preparation; no acquisition.'};
   const candidates=compileDiscoveryCandidates(brief,boundary,now).map((record,n)=>({...record,candidateId:uid(400+index*10+n)}));
   repository.admit(scope,work,understandingDigest(work),understandingDigest(index),boundary,()=>true);repository.start(scope,String(work.workId));if(!repository.publish(scope,String(work.workId),boundary,[brief,...candidates],()=>true))throw new Error('Synthetic preparation was not published');
  }
  const records:RelationshipContextRecord[]=[{id:'lab-evidence:explicit',content:'Explicit synthetic statement: Forest Chronicle is my favorite. Activity is not proof of enjoyment. Missing imports do not establish dislike.',revision:1,sourceFamily:'family:lab:explicit',status:'approved',use:'baseline',personalization:true,mention:true}];
  const rows:DiscoveryLabRow[]=[];
  for(const scenario of scenarios)for(const variant of ['baseline','enabled','selected']){
   const settings=variant==='selected'?selected:{...selected,enabled:variant==='enabled',budget:{...selected.budget,enrichmentTokens:512,selectedItems:4,optionalSelectionDeadlineMs:10}};
   const view=compileRelationshipContext({records,userInput:scenario.prompt,audienceScope:'authenticatedSession',profileRevision:'lab-profile:1',relationshipRevision:'lab-relationship:1',configurationRevision:'lab-settings:1',controls:variant==='selected'?configuration.controls:relationshipControlDefaults,representation:configuration.representation??'recordOriented'});
   const permitted=variant!=='selected'||selected.policyRefs.includes(policy);
   const enrichment=selectDiscoveryContext({repository,scope,boundary,input:scenario.prompt,audience:'authenticatedSession',remainingBytes:view.budget.maximumBytes-view.budget.usedBytes,settings:{...settings,enabled:settings.enabled&&permitted},current:()=>true,recent:id=>variant==='selected'&&facts.some((fact,index)=>id===`discovery-candidate:${uid(400+index*10)}`&&(selected.excludedTopicRefs.includes(fact.topic)||selected.excludedSourceRefs.includes(`source:discovery-lab:${index+1}`)))});
   appendDiscoveryContext(view,enrichment);
   const request=buildCanonicalPrompt({assistantId:scope.assistantId,sessionId:'lab:synthetic',interactionId:`lab:${scenario.id}:${variant}`,endpointId:null,userInput:scenario.prompt,preparedRelationshipContext:view,executionMode:'replay',capabilities:'No tools, research, delivery, configuration changes or memory writes.',conversation:'Frozen synthetic comparison; no live or prior conversation.'});
   const memory=request.sections.find(section=>section.kind==='preparedMemory')!.content;
   const shouldEnrich=settings.enabled&&permitted&&settings.budget.enrichmentTokens!>0&&settings.budget.selectedItems!>0;
   const checks=[{name:'total prepared context within limit',pass:Buffer.byteLength(memory)<=view.budget.maximumBytes},{name:'independent enrichment bound',pass:enrichment.tokenUpperBound<=settings.budget.enrichmentTokens!&&enrichment.items.length<=settings.budget.selectedItems!},{name:'mandatory evidence retained when personalization enabled',pass:(variant==='selected'?configuration.controls.personalizationIntensity:relationshipControlDefaults.personalizationIntensity)===0||memory.includes('Missing imports do not establish dislike')},{name:'forbidden alternate detail absent',pass:scenario.forbidden.every(value=>!memory.includes(value))},{name:'expected contextual detail',pass:!shouldEnrich||scenario.required.every(value=>memory.includes(value))}];
   rows.push({id:scenario.id,split:scenario.split,variant,prompt:scenario.prompt,note:scenario.note,memory,manifestDigest:understandingDigest(request.manifest),sourceRefs:enrichment.items.map(item=>item.id),disposition:enrichment.disposition,selectedItems:enrichment.items.length,tokenUpperBound:enrichment.tokenUpperBound,elapsedMs:enrichment.elapsedMs,checks});
  }
  return {scenarioRevision:understandingDigest({facts,scenarios}),configurationDigest:understandingDigest(configuration),rows,canonicalRequestCount:rows.length,providerCalls:0};
 }finally {database.close();}
}
if(parentPort){try{parentPort.postMessage({report:runDiscoveryInputLab(workerData.configuration)});}catch(error){parentPort.postMessage({error:error instanceof Error?error.message:'Comparison failed'});}}
