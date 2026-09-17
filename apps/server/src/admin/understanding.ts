import {evidenceDependency} from './discovery-preference.ts';
import {DiscoveryInputLab} from './discovery-lab.ts';
import {compileDiscoveryCandidates} from './discovery-candidates.ts';
import {analyzeDiscoveryEvidence,type DiscoveryAnalysisPort,type DiscoveryEvidence} from "./discovery-analysis.ts";
import { recoveryDigest } from "./recovery-journal.ts";
import { randomUUID } from "node:crypto";
import { createContractValidator } from "@lifestream/contracts";
import { UnderstandingRepository, understandingDigest, hypothesisFingerprint, candidateFingerprint, type Database, type UnderstandingRecord, type UnderstandingScope } from "@lifestream/storage-sqlite";
import type {HypothesisRejection,CandidateSuppression} from './recovery-journal.ts';
import { UnderstandingWorkCoordinator, SHARED_PROVIDER_PREEMPTION_BOUND_MS, SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS } from "@lifestream/runtime/understanding/coordinator";
import {selectDiscoveryContext} from "./discovery-selection.ts";
import { extensionError, type RelationshipConfiguration } from "../relationship-extensions.ts";

type Result = {status:number;body:Record<string,unknown>};
type Snapshot = { boundary:string; configuration:RelationshipConfiguration|undefined };
type Claim = {claimId:string;text:string;sourceRefs:string[];qualifier:string;versionScope:string;spoilerClass:string;contradictionRefs:string[]};
type Source = {sourceRef:string;sourceFamily:string;sourceRevision:string;topicRef:string;policyRef:string;retrievedAt:string;reliability:string;reliabilityBasis:string;content:string;claims:Claim[];aliasClaims:Claim[];knowledgeGaps:string[]};
type Settings = {explorationShare:number;enabled:boolean;researchMode:string;policyRefs:string[];approvedTopicRefs:string[];excludedSourceRefs:string[];excludedTopicRefs:string[];spoilerPolicy:string;progressBoundaryRef:string|null;budget:Record<string,number>};
type DiscoveryHost={preferenceRefs?:(scope:UnderstandingScope,topic:string)=>string[];configuration?:(scope:UnderstandingScope,id:string)=>RelationshipConfiguration|undefined;suppressCandidate?:(scope:UnderstandingScope,target:CandidateSuppression|undefined,request:Record<string,unknown>)=>'missing'|'applied'|'pending'|'conflict';rejectHypothesis?:(scope:UnderstandingScope,target:HypothesisRejection|undefined,request:Record<string,unknown>)=>'missing'|'applied'|'pending'|'conflict';snapshot:(scope:UnderstandingScope)=>Snapshot;evidenceAllowed:(scope:UnderstandingScope,refs:string[])=>boolean;sourceAllowed:(scope:UnderstandingScope,value:string)=>boolean;forget:(scope:UnderstandingScope,targets:{refs:string[];contentDigests:string[]}|undefined,request:Record<string,unknown>)=>"missing"|"applied"|"pending"|"conflict";feedback?:(scope:UnderstandingScope,request:Record<string,unknown>)=>{recordRef:string;replay:boolean};analysis?:()=>DiscoveryAnalysisPort|undefined;evidence?:(scope:UnderstandingScope,refs:string[])=>DiscoveryEvidence[];changed:()=>void};
const validator=createContractValidator();
const schema="https://lifestream.dev/contracts/understanding-api/1.0.0";
export class DiscoveryAdministration {
  readonly repository:UnderstandingRepository;
  private readonly coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>process.memoryUsage().heapUsed<256*1024*1024});
  private readonly tasks=new Map<string,{relationshipId:string;scope:UnderstandingScope;promise:Promise<unknown>}>();
  private readonly retryQueue=new Map<string,{relationshipId:string;scope:UnderstandingScope;run:()=>Promise<void>;attempt:number}>();
  private closed=false;
  private readonly inputLab=new DiscoveryInputLab();
  private readonly recent=new Map<string,{revision:number;ids:Map<string,number>}>();
  private readonly cleanupTimer:ReturnType<typeof setInterval>;
  private readonly retryTimer:ReturnType<typeof setInterval>;
  private readonly removeIdleListener:()=>void;
  private readonly host:DiscoveryHost;
  constructor(database:Database,host:DiscoveryHost){
    this.host=host;this.repository=new UnderstandingRepository(database);this.repository.recover();
    this.cleanupTimer=setInterval(()=>{try{this.repository.cleanupExpired();}catch{/* Expired data remains denied; retry bounded maintenance on the next interval. */}},30000);
    this.cleanupTimer.unref();
    this.retryTimer=setInterval(()=>this.drainRetries(),1000);this.retryTimer.unref();
    this.removeIdleListener=this.coordinator.onIdle(()=>this.drainRetries());
  }
  private recentKey(scope:UnderstandingScope,sessionId:string):string{return understandingDigest([scope.assistantId,scope.userId,scope.relationshipId,scope.deploymentId,sessionId]);}
  selectionRevision(scope:UnderstandingScope,sessionId?:string):number{return sessionId?this.recent.get(this.recentKey(scope,sessionId))?.revision??0:0;}
  noteRequest(scope:UnderstandingScope,sessionId:string,ids:string[]):void {
    if(!ids.length)return;const key=this.recentKey(scope,sessionId),entry=this.recent.get(key)??{revision:0,ids:new Map<string,number>()};
    for(const id of ids.slice(0,8))if(/^discovery-candidate:[a-f0-9-]{36}$/u.test(id))entry.ids.set(id,Date.now()+600000);
    while(entry.ids.size>32)entry.ids.delete(entry.ids.keys().next().value!);entry.revision++;this.recent.delete(key);this.recent.set(key,entry);while(this.recent.size>128)this.recent.delete(this.recent.keys().next().value!);
  }
  foregroundStarted():()=>void{return this.coordinator.foregroundStarted();}
  close():void{if(this.closed)return;this.closed=true;this.inputLab.close();this.recent.clear();clearInterval(this.cleanupTimer);clearInterval(this.retryTimer);this.removeIdleListener();this.retryQueue.clear();for(const [key,task] of this.tasks){this.coordinator.cancel(key,"shutdown");this.repository.finish(task.scope,key,"cancelled","Runtime closed; no automatic replay.");}}
  invalidate(relationshipId:string):void{for(const [key,entry]of this.retryQueue)if(entry.relationshipId===relationshipId){this.retryQueue.delete(key);this.repository.finish(entry.scope,key,"cancelled","Current authorization or evidence changed; idle retry withheld.");}for(const [key,task]of this.tasks)if(task.relationshipId===relationshipId)this.coordinator.cancel(key,"scopeInvalidated");}
  private queueRetry(key:string,entry:{relationshipId:string;scope:UnderstandingScope;run:()=>Promise<void>;attempt:number},reason:string):void {
    if(this.closed)return;
    const current=this.repository.work(entry.scope,key),configured=Number((current?.budget as Record<string,unknown>|undefined)?.automaticRetries),maximum=Number.isInteger(configured)&&configured>=0&&configured<=3?configured:0;
    if(entry.attempt>=maximum){this.repository.finish(entry.scope,key,"failed",`Idle retry budget exhausted after ${entry.attempt} deferred attempts (${reason}).`);return;}
    if(!this.repository.requeue(entry.scope,key,`Deferred while foreground work had priority; waiting for idle retry (${entry.attempt+1}/${maximum}).`))return;
    this.retryQueue.set(key,{...entry,attempt:entry.attempt+1});
    this.drainRetries();
  }
  private drainRetries():void {
    if(this.closed||this.tasks.size>0||!this.coordinator.isIdle()||this.retryQueue.size===0)return;
    const first=[...this.retryQueue.entries()][0];if(!first)return;
    const [key,entry]=first;this.retryQueue.delete(key);
    const promise=entry.run().finally(()=>{if(this.tasks.get(key)?.promise===promise)this.tasks.delete(key);if(this.retryQueue.size)this.drainRetries();});
    this.tasks.set(key,{relationshipId:entry.relationshipId,scope:entry.scope,promise});
  }
  records(scope:UnderstandingScope):UnderstandingRecord[]{return this.repository.list(scope,this.host.snapshot(scope).boundary);}
  private response(scope:UnderstandingScope,operation:string,records:UnderstandingRecord[],message:string,status=200):Result{
    const body={schemaVersion:"1.0.0",relationshipId:scope.relationshipId,operation,activeConfigurationId:this.host.snapshot(scope).configuration?.configurationId??null,records:records.slice(0,128),explanations:[{code:"discovery_status",summary:message,sourceRefs:[]}],activeStateChanged:false,executionMode:"live",nextCursor:null};
    if(!validator.validate(schema+"#/$defs/Response",body).valid)throw new Error("Invalid Discovery response");
    return {status,body};
  }
  handle(inputScope:UnderstandingScope,input:unknown,authorizationCurrent:()=>boolean):Result{
    const scope:UnderstandingScope={assistantId:inputScope.assistantId,userId:inputScope.userId,relationshipId:inputScope.relationshipId,deploymentId:inputScope.deploymentId};
    if(!validator.validate(schema+"#/$defs/Request",input).valid)return extensionError(422,"invalid_discovery_request","Unsupported Discovery request.");
    const request=input as Record<string,unknown>,operation=String(request.operation);
    if(this.closed||!authorizationCurrent())return extensionError(403,"discovery_scope_denied","Current relationship authorization is required.");
    if(operation==='compare'){
      try {
        const configuration=this.host.configuration?.(scope,String(request.configurationId));
        if(!configuration?.extensions?.understanding||configuration.quarantined||configuration.relationshipId!==scope.relationshipId)return extensionError(404,'comparison_configuration_unavailable','Select an available Discovery configuration in this relationship.');
        const snapshot=this.host.snapshot(scope),entry=this.inputLab.readOrStart(understandingDigest(scope),snapshot.boundary,configuration);
        if(entry.error)return extensionError(409,'comparison_failed',entry.error);
        const response=this.response(scope,operation,[],entry.report?'Isolated input comparison completed.':'Isolated input comparison is running. Refresh comparison to read its result.',entry.report?200:202);
        response.body.executionMode='simulation';
        if(entry.report){
          const failed=entry.report.rows.filter(row=>row.checks.some(check=>!check.pass)).length;
          response.body.explanations=[{code:'lab_summary',summary:`${entry.report.canonicalRequestCount} canonical requests assembled; ${failed} rows have failed input expectations. No model was called. These are input checks, not conversational quality, provider latency or Human acceptance. No live state was changed. Results expire after ten minutes.`,sourceRefs:[`scenario:${entry.report.scenarioRevision}`,`configuration:${entry.configurationDigest}`]},
            {code:'lab_policy',summary:'Baseline keeps mandatory synthetic evidence with Discovery disabled. Enabled uses the fixed 512-token reference allocation. Selected uses the chosen saved settings, including exclusions; fixture sources require policy:discovery-lab-v1. Comparisons never activate settings. The six input cases are a component scenario set; all canonical Discovery demonstrations and actual model-output evaluations remain pending.',sourceRefs:[]},
            ...entry.report.rows.flatMap(row=>{
              if(row.memory.length>3600)throw new Error('Comparison input exceeds the bounded inspector capacity');
              const prefix=`lab:${row.id}:${row.variant}`;
              return [{code:prefix+':checks',summary:`${row.split==='heldOut'?'Held-out':'Comparison'} · ${row.note}\n${row.checks.map(check=>`${check.pass?'PASS':'FAIL'}: ${check.name}`).join('\n')}\nSelection: ${row.disposition}; ${row.selectedItems} items; ${row.tokenUpperBound} estimated tokens (UTF-8 byte upper bound); ${row.elapsedMs.toFixed(3)} ms total local selection (${row.lookupElapsedMs.toFixed(3)} ms lookup/filter; ${row.selectionElapsedMs.toFixed(3)} ms inner selection). This is not a performance certification.`,sourceRefs:[`manifest:${row.manifestDigest}`,...row.sourceRefs]},
                {code:prefix+':input',summary:`Prompt: ${row.prompt}\nPrepared memory (part 1):\n${row.memory.slice(0,1700)}`,sourceRefs:[]},...(row.memory.length>1700?[{code:prefix+':more',summary:`Prepared memory (continued):\n${row.memory.slice(1700)}`,sourceRefs:[]}]:[])];
            })];
        }
        if(!authorizationCurrent()||snapshot.boundary!==this.host.snapshot(scope).boundary)return extensionError(409,'comparison_scope_changed','Comparison scope changed. Refresh before comparing.');
        if(!validator.validate(schema+'#/$defs/Response',response.body).valid)throw new Error('Invalid bounded comparison response');
        return response;
      }catch(error){return extensionError(409,'comparison_unavailable',error instanceof Error?error.message:'Comparison unavailable');}
    }
    if(operation==="feedback"){
      try {
        if(!this.host.feedback)return extensionError(409,"feedback_unavailable","This runtime has no scoped evidence writer.");
        const result=this.host.feedback(scope,request);this.invalidate(scope.relationshipId);this.host.changed();
        const response=this.response(scope,operation,[],result.replay?"Existing feedback admission; inspect its current review state in Records. No statement was recreated.":"Explicit scoped feedback is pending review in Records. Previous Discovery projections are withheld until rebuilt under the current evidence boundary.",result.replay?200:201);
        (response.body.explanations as {sourceRefs:string[]}[])[0]!.sourceRefs=[result.recordRef];return response;
      }catch(error){return extensionError(409,"feedback_conflict",error instanceof Error?error.message:"Scoped feedback could not be recorded.");}
    }
    if(operation==='disposition'&&request.decision==='suppressCandidate'){
      try{
        if(!this.host.suppressCandidate)throw new Error('Owner-local candidate suppression is unavailable');
        this.repository.assertCandidateRetry(scope,String(request.idempotencyKey),understandingDigest(request));
        let outcome=this.host.suppressCandidate(scope,undefined,request);
        if(outcome==='missing'){
          const candidate=this.records(scope).find(record=>record.recordType==='candidate'&&record.candidateId===request.recordId&&record.revision===request.expectedRevision&&record.status==='proposed');
          if(!candidate)throw new Error('Select a current proposed candidate at its current revision');
          this.invalidate(scope.relationshipId);outcome=this.host.suppressCandidate(scope,{deploymentId:scope.deploymentId,candidateId:String(candidate.candidateId),expectedRevision:Number(candidate.revision),fingerprint:candidateFingerprint(candidate)},request);
        }
        this.host.changed();if(outcome==='conflict')throw new Error('Candidate suppression retry conflict');
        if(outcome!=='applied')return extensionError(409,'candidate_suppression_pending','Suppression intent withholds derived use. Retry the same request to finish cleanup.');
        const candidate=this.records(scope).find(record=>record.candidateId===request.recordId);
        return this.response(scope,operation,candidate?[candidate]:[],'Optional candidate suppressed. Supporting evidence is unchanged; suppression survives database rollback.');
      }catch(error){return extensionError(409,'candidate_suppression_conflict',error instanceof Error?error.message:'Candidate suppression conflict');}
    }
    if(operation==='disposition'&&['reviewHypothesis','rejectHypothesis'].includes(String(request.decision))){
      try{
        if(request.decision==='reviewHypothesis'){
          const result=this.repository.reviewHypothesis(scope,String(request.recordId),Number(request.expectedRevision),String(request.idempotencyKey),understandingDigest(request),this.host.snapshot(scope).boundary,authorizationCurrent);
          this.invalidate(scope.relationshipId);this.host.changed();
          return this.response(scope,operation,[result.record],result.replay?'Existing review receipt; current hypothesis state returned.':'Reviewed for usefulness only. The hypothesis remains tentative; supporting user evidence is unchanged.');
        }
        if(!this.host.rejectHypothesis)throw new Error('Owner-local hypothesis rejection is unavailable');
        this.repository.assertReviewRetry(scope,String(request.idempotencyKey),understandingDigest(request),String(request.recordId),'rejectHypothesis');
        let outcome=this.host.rejectHypothesis(scope,undefined,request);
        if(outcome==='missing'){
          const record=this.records(scope).find(record=>record.recordType==='hypothesis'&&record.hypothesisId===request.recordId&&record.revision===request.expectedRevision&&['candidate','reviewed'].includes(String(record.status)));
          if(!record)throw new Error('Select a current hypothesis at its current revision');
          this.invalidate(scope.relationshipId);
          outcome=this.host.rejectHypothesis(scope,{deploymentId:scope.deploymentId,hypothesisId:String(record.hypothesisId),expectedRevision:Number(record.revision),fingerprint:hypothesisFingerprint(record)},request);
        }
        this.host.changed();
        if(outcome==='conflict')throw new Error('Hypothesis rejection retry conflict');
        if(outcome!=='applied')return extensionError(409,'hypothesis_rejection_pending','Rejection intent withholds derived use. Retry the same request to finish cleanup.');
        const record=this.records(scope).find(record=>record.hypothesisId===request.recordId);
        return this.response(scope,operation,record?[record]:[],'Hypothesis rejected. Supporting observations and declarations are unchanged; this hypothesis cannot be restored by database rollback.');
      }catch(error){return extensionError(409,'hypothesis_review_conflict',error instanceof Error?error.message:'Hypothesis review conflict');}
    }
    if(operation==="cancel"){
      try {
        const work=this.repository.cancel(scope,String(request.workId),Number(request.expectedRevision),String(request.idempotencyKey),understandingDigest(request));
        this.coordinator.cancel(String(work.workId));
        return this.response(scope,operation,[work],"Preparation cancelled; repeated requests do not repeat the operation.");
      } catch(error) { return extensionError(409,"work_revision_conflict",error instanceof Error?error.message:"Cancellation conflict"); }
    }
    if(operation==="disposition"&&["forgetTopic","excludeSource"].includes(String(request.decision))){
      // Ask the durable owner journal first: a successful cleanup has already erased the brief.
      let result=this.host.forget(scope,undefined,request);
      if(result==="missing") {
        const brief=this.records(scope).find(record=>record.briefId===request.recordId&&record.revision===request.expectedRevision);
        if(!brief)return extensionError(409,"discovery_record_conflict","Select a current brief at its current revision.");
        const refs=request.decision==="forgetTopic"?[String(brief.topicRef)]:(brief.sources as Source[]).map(source=>source.sourceRef);
        this.invalidate(scope.relationshipId);
        const contentDigests=(brief.dependencyRefs as string[]).filter(ref=>/^source-content:[a-f0-9]{64}$/u.test(ref)).map(ref=>ref.slice("source-content:".length));
        result=this.host.forget(scope,{refs,contentDigests},request);
      }
      if(result==="conflict")return extensionError(409,"discovery_privacy_conflict","This privacy retry identity belongs to another request.");
      if(result!=="applied")return extensionError(409,"discovery_privacy_pending","Current privacy intent withholds derived use; retry the same request to finish cleanup.");
      return this.response(scope,operation,[],"Derived payload removed. Current owner-local privacy receipts prevent replay from an older database.");
    }
    if(operation!=="prepare")return extensionError(409,"discovery_operation_unavailable","This Discovery operation is not yet implemented.");
    const snapshot=this.host.snapshot(scope),settings=snapshot.configuration?.extensions?.understanding as Settings|undefined;
    if(!settings?.enabled||settings.researchMode==="off")return extensionError(409,"discovery_disabled","Activate an enabled Discovery configuration before preparing sources.");
    if(request.purpose==="hypothesisAnalysis")return this.prepareAnalysis(scope,request,snapshot,settings,authorizationCurrent);
    const sources=request.sources as Source[],topic=String(request.topicRef),refs=[...new Set([...request.evidenceRefs as string[],...this.host.preferenceRefs?.(scope,topic)??[]])],budget=settings.budget;
    if(!sources.length)return extensionError(409,"acquisition_unavailable","No configured network acquisition capability is available. Select and supply authorized source material.");
    const current=()=>!this.closed&&process.memoryUsage().heapUsed<budget.workerMemoryMiB!*1024*1024&&authorizationCurrent()&&snapshot.boundary===this.host.snapshot(scope).boundary&&this.host.evidenceAllowed(scope,refs)&&this.host.sourceAllowed(scope,topic)&&sources.every(source=>this.host.sourceAllowed(scope,source.sourceRef)&&this.host.sourceAllowed(scope,source.content)&&Date.parse(source.retrievedAt)+budget.briefFreshnessSeconds!*1000>Date.now());
    try{
      if(refs.length>24)throw new Error("Too many current evidence references");
      if(!current()||settings.excludedTopicRefs.includes(topic)||sources.some(source=>settings.excludedSourceRefs.includes(source.sourceRef)))throw new Error("Current source, evidence or topic use is denied");
      if(settings.researchMode==="approvedTopics"&&!settings.approvedTopicRefs.includes(topic))throw new Error("Topic is not approved");
      const sourceBytes=Buffer.byteLength(JSON.stringify(sources));
      if(sources.length>budget.documentsPerJob!||sourceBytes>budget.inputBytesPerJob!||sourceBytes>budget.sourceTokensPerJob!||this.tasks.size>=budget.pendingJobsPerRuntime!)throw new Error("Supplied-source budget exceeded (UTF-8 bytes are a conservative token bound)");
      if(new Set(sources.map(source=>source.sourceRef)).size!==sources.length)throw new Error("Duplicate source references require one explicit revision");
      const now=Date.now();
      for(const source of sources){if(source.topicRef!==topic||!settings.policyRefs.includes(source.policyRef)||Date.parse(source.retrievedAt)>now||Date.parse(source.retrievedAt)+budget.briefFreshnessSeconds!*1000<=now)throw new Error("Source topic, policy or freshness is not eligible");
        for(const claim of [...source.claims,...source.aliasClaims])if(!claim.sourceRefs.includes(source.sourceRef)||claim.sourceRefs.some(ref=>!sources.some(s=>s.sourceRef===ref))||!source.content.includes(claim.text))throw new Error("A claim must be an attributed excerpt present in its selected source");
      }
      const configurationRef=`relationship-configuration:${snapshot.configuration!.configurationId}:${snapshot.configuration!.revision}`;
      const evidence=this.host.evidence?.(scope,refs)??[];
      const dependencyRefs=[`snapshot:${snapshot.boundary}`,...refs.map(ref=>{const item=evidence.find(item=>item.ref===ref);return item?evidenceDependency(item):ref;}),...sources.map(source=>`source:${understandingDigest([source.sourceRef,source.sourceRevision,source.content])}`),...new Set(sources.map(source=>`source-content:${recoveryDigest(source.content)}`))];
      if(dependencyRefs.length>31)throw new Error("Too many dependency references for parent and candidates");
      const work:UnderstandingRecord={...scope,schemaVersion:"1.0.0",recordType:"work",workId:randomUUID(),revision:1,topicRef:topic,purpose:request.purpose,state:"queued",executionMode:"normal",idempotencyKey:request.idempotencyKey,configurationRef,policyRefs:[...new Set(sources.map(source=>source.policyRef))],dependencyRefs,capabilityInvocationRef:null,admissionReceiptRef:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+budget.jobDeadlineSeconds!*1000).toISOString(),expiresAt:new Date(now+budget.pendingJobTtlSeconds!*1000).toISOString(),budget:structuredClone(budget),producedRefs:[],lastOutcome:"notRun",reason:"Queued supplied-source preparation; no external acquisition."};
      const {idempotencyKey:_key,...semanticRequest}=request;
      const admitted=this.repository.admit(scope,work,understandingDigest(request),understandingDigest([semanticRequest,snapshot.boundary]),snapshot.boundary,()=>current(),{share:settings.explorationShare,approvedTopicRefs:settings.approvedTopicRefs.filter(ref=>!settings.excludedTopicRefs.includes(ref)&&this.host.sourceAllowed(scope,ref))});
      if(admitted.replay)return this.response(scope,operation,[admitted.record],"Existing admission; no repeated preparation.");
      const key=String(work.workId);
      const run=async(attempt:number):Promise<void>=>{
        if(this.closed)return;
        const latest=this.repository.work(scope,key);if(!latest)return;
        const result=await this.coordinator.run({key,deadlineAt:Date.parse(String(latest.deadlineAt)),current,admitOnce:()=>this.repository.start(scope,key),sharedInference:false,priority:"P1",
          steps:[async signal=>{
            if(signal.aborted||!current())throw new Error("Preparation cancelled");
            const permitted=(claim:Claim)=>claim.spoilerClass==="none"||settings.spoilerPolicy==="allow"||settings.spoilerPolicy==="throughKnownProgress"&&claim.spoilerClass==="withinDeclaredProgress"&&!!settings.progressBoundaryRef;
            const claims=sources.flatMap(source=>source.claims.filter(permitted).map(claim=>({...claim,qualifier:claim.qualifier==="corroborated"?"attributed":claim.qualifier}))).slice(0,32);
            if(!claims.length)throw new Error("No source claims remain within spoiler policy");
            const aliasClaims=sources.flatMap(source=>source.aliasClaims.filter(permitted).map(claim=>({...claim,qualifier:claim.qualifier==="corroborated"?"attributed":claim.qualifier}))).slice(0,16);
            const freshUntil=Math.min(now+budget.briefFreshnessSeconds!*1000,...sources.map(source=>Date.parse(source.retrievedAt)+budget.briefFreshnessSeconds!*1000));
            const brief:UnderstandingRecord={...scope,schemaVersion:"1.0.0",recordType:"topicBrief",briefId:randomUUID(),revision:1,topicRef:topic,derived:true,status:"prepared",sources:sources.map(({content:_content,claims:_claims,aliasClaims:_aliases,knowledgeGaps:_gaps,topicRef:_topic,...source})=>({...source,kind:"providedFixture"})),claims,aliasClaims,knowledgeGaps:[...new Set(sources.flatMap(source=>source.knowledgeGaps))].slice(0,16),deeperMaterialRefs:[],builtAt:new Date().toISOString(),freshUntil:new Date(freshUntil).toISOString(),compilerRef:"provided-source-attribution:1",dependencyRefs,configurationRef};
            return brief;
          }],publish:brief=>this.repository.publish(scope,key,snapshot.boundary,[brief,...compileDiscoveryCandidates(brief,snapshot.boundary,Date.now(),evidence)],()=>current())});
        // A preemption is retryable only while the pinned source, authorization,
        // evidence and boundary are still current.  A foreground turn can abort
        // the provider at the same time that privacy or evidence revocation is
        // observed; stale dependencies always win and become terminal.
        if(!this.closed&&result.state!=="published"&&current()&&["foregroundPreempted","foregroundOrCapacity","deferredP2","capacityPressure"].includes(result.reason)){this.queueRetry(key,{relationshipId:scope.relationshipId,scope,run:()=>run(attempt+1),attempt},result.reason);return;}
        if(!this.closed&&result.state!=="published")this.repository.finish(scope,key,result.state==="failed"?"failed":"cancelled",result.reason);
        if(!this.closed&&result.state==="published")this.host.changed();
      };
      const promise=new Promise<void>(resolve=>setImmediate(resolve)).then(()=>run(0)).catch(()=>{if(!this.closed)this.repository.finish(scope,key,"failed","Preparation failed without publication.");});
      this.tasks.set(key,{relationshipId:scope.relationshipId,scope,promise});void promise.finally(()=>{if(this.tasks.get(key)?.promise===promise)this.tasks.delete(key);if(this.retryQueue.size)this.drainRetries();});
      return this.response(scope,operation,[work],"Preparation admitted. Refresh to inspect its observed terminal result.",202);
    }catch(error){return extensionError(409,"discovery_admission_denied",error instanceof Error?error.message:"Discovery admission denied");}
  }
  private prepareAnalysis(scope:UnderstandingScope,request:Record<string,unknown>,snapshot:Snapshot,settings:Settings,authorizationCurrent:()=>boolean):Result {
    const selectedPort=this.host.analysis?.(),port=selectedPort?{...selectedPort}:undefined;
    if(!port||port.preemptionBoundMs===undefined||!Number.isFinite(port.preemptionBoundMs)||port.preemptionBoundMs<0||port.preemptionBoundMs>SHARED_PROVIDER_PREEMPTION_BOUND_MS||port.slotReleaseBoundMs===undefined||!Number.isFinite(port.slotReleaseBoundMs)||port.slotReleaseBoundMs<0||port.slotReleaseBoundMs>SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS)return extensionError(409,"provider_priority_unverified","Optional model analysis is withheld until shared-provider cancellation and slot-release bounds are qualified. Supplied-source preparation remains available.");
    try {
      const budget=settings.budget,refs=request.evidenceRefs as string[],topic=String(request.topicRef);
      if(!refs.length||refs.length>24||!this.host.evidence||budget.analysisCallsPerJob!<1||!settings.policyRefs.length||settings.excludedTopicRefs.includes(topic))throw new Error("Current evidence, topic policy and analysis budget are required");
      if(settings.researchMode==="approvedTopics"&&!settings.approvedTopicRefs.includes(topic))throw new Error("Topic is not approved");
      if((request.sources as unknown[]).length)throw new Error("Prepare supplied sources separately; hypothesis analysis consumes scoped personal evidence without acquiring topic material");
      const evidence=this.host.evidence(scope,refs);if(evidence.length!==refs.length||new Set(refs).size!==refs.length||new Set(evidence.map(item=>item.ref)).size!==refs.length||evidence.some(item=>!refs.includes(item.ref)))throw new Error("Some selected evidence is unavailable");
      const current=()=>{const livePort=this.host.analysis?.(),liveEvidence=this.host.evidence?.(scope,refs)??[];return !this.closed&&authorizationCurrent()&&snapshot.boundary===this.host.snapshot(scope).boundary&&livePort?.identity===port.identity&&livePort?.preemptionBoundMs===port.preemptionBoundMs&&livePort?.slotReleaseBoundMs===port.slotReleaseBoundMs&&liveEvidence.length===evidence.length&&liveEvidence.every((item,index)=>item.ref===evidence[index]?.ref&&item.revision===evidence[index]?.revision&&item.content===evidence[index]?.content)&&this.host.evidenceAllowed(scope,refs)&&this.host.sourceAllowed(scope,topic)&&process.memoryUsage().heapUsed<budget.workerMemoryMiB!*1024*1024;};
      if(!current())throw new Error("Current analysis scope denied");
      const now=Date.now(),key=randomUUID(),configurationRef=`relationship-configuration:${snapshot.configuration!.configurationId}:${snapshot.configuration!.revision}`;
      const dependencyRefs=[`snapshot:${snapshot.boundary}`,`analysis-provider:${understandingDigest(port.identity)}`,...evidence.map(e=>`evidence:${e.ref}:${e.revision}`)];
      const work:UnderstandingRecord={...scope,schemaVersion:"1.0.0",recordType:"work",workId:key,revision:1,topicRef:topic,purpose:"hypothesisAnalysis",state:"queued",executionMode:"normal",idempotencyKey:request.idempotencyKey,configurationRef,policyRefs:settings.policyRefs,dependencyRefs,capabilityInvocationRef:null,admissionReceiptRef:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+budget.jobDeadlineSeconds!*1000).toISOString(),expiresAt:new Date(now+budget.pendingJobTtlSeconds!*1000).toISOString(),budget:structuredClone(budget),producedRefs:[],lastOutcome:"notRun",reason:"Queued bounded competing-hypothesis analysis; canonical user evidence remains unchanged."};
      const {idempotencyKey:_key,...semantic}=request;
      const admitted=this.repository.admit(scope,work,understandingDigest(request),understandingDigest([semantic,snapshot.boundary,port.identity]),snapshot.boundary,()=>current(),{share:settings.explorationShare,approvedTopicRefs:settings.approvedTopicRefs.filter(ref=>!settings.excludedTopicRefs.includes(ref)&&this.host.sourceAllowed(scope,ref))});
      if(admitted.replay)return this.response(scope,"prepare",[admitted.record],"Existing analysis admission; no repeated provider call.");
      const run=async(attempt:number):Promise<void>=>{
        if(this.closed)return;
        const latest=this.repository.work(scope,key);if(!latest)return;
        const result=await this.coordinator.run({key,deadlineAt:Date.parse(String(latest.deadlineAt)),current,admitOnce:()=>this.repository.start(scope,key),sharedInference:true,priority:"P2",providerPreemptionBoundMs:port.preemptionBoundMs!,providerSlotReleaseBoundMs:port.slotReleaseBoundMs!,
          steps:[async signal=>(await analyzeDiscoveryEvidence({scope,topicRef:topic,workId:key,configurationRef,dependencyRefs,evidence,port,maximumOutputTokens:budget.outputTokensPerCall!,maximumInputBytes:Math.min(budget.inputBytesPerJob!,budget.sourceTokensPerJob!),deadlineAt:String(latest.deadlineAt),signal,current})).record],
          publish:record=>this.repository.publish(scope,key,snapshot.boundary,[record,...compileDiscoveryCandidates(record,snapshot.boundary)],()=>current())});
        if(!this.closed&&result.state!=="published"&&current()&&["foregroundPreempted","foregroundOrCapacity","deferredP2","capacityPressure"].includes(result.reason)){this.queueRetry(key,{relationshipId:scope.relationshipId,scope,run:()=>run(attempt+1),attempt},result.reason);return;}
        if(!this.closed&&result.state!=="published")this.repository.finish(scope,key,result.state==="failed"?"failed":"cancelled",result.reason);
        if(!this.closed&&result.state==="published")this.host.changed();
      };
      const promise=new Promise<void>(resolve=>setImmediate(resolve)).then(()=>run(0)).catch(()=>{if(!this.closed)this.repository.finish(scope,key,"failed","Analysis failed without publication.");});
      this.tasks.set(key,{relationshipId:scope.relationshipId,scope,promise});void promise.finally(()=>{if(this.tasks.get(key)?.promise===promise)this.tasks.delete(key);if(this.retryQueue.size)this.drainRetries();});return this.response(scope,"prepare",[work],"Analysis admitted. Its explanations remain tentative and require review.",202);
    }catch(error){return extensionError(409,"analysis_admission_denied",error instanceof Error?error.message:"Analysis admission denied");}
  }
  select(scope:UnderstandingScope,input:string,audience:"authenticatedSession"|"unknown",remainingBytes:number,sessionId?:string){
    const snapshot=this.host.snapshot(scope),recent=sessionId?this.recent.get(this.recentKey(scope,sessionId)):undefined;
    return selectDiscoveryContext({repository:this.repository,scope,boundary:snapshot.boundary,input,audience,remainingBytes,settings:snapshot.configuration?.extensions?.understanding as Settings|undefined,current:()=>snapshot.boundary===this.host.snapshot(scope).boundary,recent:id=>(recent?.ids.get(id)??0)>Date.now()});
  }
}
