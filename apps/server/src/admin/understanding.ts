import {analyzeDiscoveryEvidence,type DiscoveryAnalysisPort,type DiscoveryEvidence} from "./discovery-analysis.ts";
import { recoveryDigest } from "./recovery-journal.ts";
import { randomUUID } from "node:crypto";
import { createContractValidator } from "@lifestream/contracts";
import { UnderstandingRepository, understandingDigest, type Database, type UnderstandingRecord, type UnderstandingScope } from "@lifestream/storage-sqlite";
import { UnderstandingWorkCoordinator } from "@lifestream/runtime/understanding/coordinator";
import { selectPreparedEnrichment } from "@lifestream/runtime/understanding/selection";
import { extensionError, type RelationshipConfiguration } from "../relationship-extensions.ts";

type Result = {status:number;body:Record<string,unknown>};
type Snapshot = { boundary:string; configuration:RelationshipConfiguration|undefined };
type Claim = {claimId:string;text:string;sourceRefs:string[];qualifier:string;versionScope:string;spoilerClass:string;contradictionRefs:string[]};
type Source = {sourceRef:string;sourceFamily:string;sourceRevision:string;topicRef:string;policyRef:string;retrievedAt:string;reliability:string;reliabilityBasis:string;content:string;claims:Claim[];aliasClaims:Claim[];knowledgeGaps:string[]};
type Settings = {enabled:boolean;researchMode:string;policyRefs:string[];approvedTopicRefs:string[];excludedSourceRefs:string[];excludedTopicRefs:string[];spoilerPolicy:string;progressBoundaryRef:string|null;budget:Record<string,number>};
type DiscoveryHost={snapshot:(scope:UnderstandingScope)=>Snapshot;evidenceAllowed:(scope:UnderstandingScope,refs:string[])=>boolean;sourceAllowed:(scope:UnderstandingScope,value:string)=>boolean;forget:(scope:UnderstandingScope,targets:{refs:string[];contentDigests:string[]}|undefined,request:Record<string,unknown>)=>"missing"|"applied"|"pending"|"conflict";feedback?:(scope:UnderstandingScope,request:Record<string,unknown>)=>{recordRef:string;replay:boolean};analysis?:()=>DiscoveryAnalysisPort|undefined;evidence?:(scope:UnderstandingScope,refs:string[])=>DiscoveryEvidence[];changed:()=>void};
const validator=createContractValidator();
const schema="https://lifestream.dev/contracts/understanding-api/1.0.0";
export class DiscoveryAdministration {
  readonly repository:UnderstandingRepository;
  private readonly coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>process.memoryUsage().heapUsed<256*1024*1024});
  private readonly tasks=new Map<string,{relationshipId:string;scope:UnderstandingScope;promise:Promise<unknown>}>();
  private closed=false;
  private readonly cleanupTimer:ReturnType<typeof setInterval>;
  private readonly host:DiscoveryHost;
  constructor(database:Database,host:DiscoveryHost){
    this.host=host;this.repository=new UnderstandingRepository(database);this.repository.recover();
    this.cleanupTimer=setInterval(()=>{try{this.repository.cleanupExpired();}catch{/* Expired data remains denied; retry bounded maintenance on the next interval. */}},30000);
    this.cleanupTimer.unref();
  }
  foregroundStarted():()=>void{return this.coordinator.foregroundStarted();}
  close():void{if(this.closed)return;this.closed=true;clearInterval(this.cleanupTimer);for(const [key,task] of this.tasks){this.coordinator.cancel(key);this.repository.finish(task.scope,key,"cancelled","Runtime closed; no automatic replay.");}}
  invalidate(relationshipId:string):void{for(const [key,task]of this.tasks)if(task.relationshipId===relationshipId)this.coordinator.cancel(key);}
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
    if(operation==="feedback"){
      try {
        if(!this.host.feedback)return extensionError(409,"feedback_unavailable","This runtime has no scoped evidence writer.");
        const result=this.host.feedback(scope,request);this.invalidate(scope.relationshipId);this.host.changed();
        const response=this.response(scope,operation,[],result.replay?"Existing feedback admission; inspect its current review state in Records. No statement was recreated.":"Explicit scoped feedback is pending review in Records. Previous Discovery projections are withheld until rebuilt under the current evidence boundary.",result.replay?200:201);
        (response.body.explanations as {sourceRefs:string[]}[])[0]!.sourceRefs=[result.recordRef];return response;
      }catch(error){return extensionError(409,"feedback_conflict",error instanceof Error?error.message:"Scoped feedback could not be recorded.");}
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
    const sources=request.sources as Source[],refs=request.evidenceRefs as string[],topic=String(request.topicRef),budget=settings.budget;
    if(!sources.length)return extensionError(409,"acquisition_unavailable","No configured network acquisition capability is available. Select and supply authorized source material.");
    const current=()=>!this.closed&&process.memoryUsage().heapUsed<budget.workerMemoryMiB!*1024*1024&&authorizationCurrent()&&snapshot.boundary===this.host.snapshot(scope).boundary&&this.host.evidenceAllowed(scope,refs)&&this.host.sourceAllowed(scope,topic)&&sources.every(source=>this.host.sourceAllowed(scope,source.sourceRef)&&this.host.sourceAllowed(scope,source.content));
    try{
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
      const dependencyRefs=[`snapshot:${snapshot.boundary}`,...refs,...sources.map(source=>`source:${understandingDigest([source.sourceRef,source.sourceRevision,source.content])}`),...new Set(sources.map(source=>`source-content:${recoveryDigest(source.content)}`))];
      if(dependencyRefs.length>32)throw new Error("Too many dependency references");
      const work:UnderstandingRecord={...scope,schemaVersion:"1.0.0",recordType:"work",workId:randomUUID(),revision:1,topicRef:topic,purpose:request.purpose,state:"queued",executionMode:"normal",idempotencyKey:request.idempotencyKey,configurationRef,policyRefs:[...new Set(sources.map(source=>source.policyRef))],dependencyRefs,capabilityInvocationRef:null,admissionReceiptRef:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+budget.jobDeadlineSeconds!*1000).toISOString(),expiresAt:new Date(now+budget.pendingJobTtlSeconds!*1000).toISOString(),budget:structuredClone(budget),producedRefs:[],lastOutcome:"notRun",reason:"Queued supplied-source preparation; no external acquisition."};
      const {idempotencyKey:_key,...semanticRequest}=request;
      const admitted=this.repository.admit(scope,work,understandingDigest(request),understandingDigest([semanticRequest,snapshot.boundary]),snapshot.boundary,()=>current());
      if(admitted.replay)return this.response(scope,operation,[admitted.record],"Existing admission; no repeated preparation.");
      const key=String(work.workId);
      const promise=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
        if(this.closed)return;
        const result=await this.coordinator.run({key,deadlineAt:Date.parse(String(work.deadlineAt)),current,admitOnce:()=>this.repository.start(scope,key),sharedInference:false,
          steps:[async signal=>{
            if(signal.aborted||!current())throw new Error("Preparation cancelled");
            const permitted=(claim:Claim)=>claim.spoilerClass==="none"||settings.spoilerPolicy==="allow"||settings.spoilerPolicy==="throughKnownProgress"&&claim.spoilerClass==="withinDeclaredProgress"&&!!settings.progressBoundaryRef;
            const claims=sources.flatMap(source=>source.claims.filter(permitted).map(claim=>({...claim,qualifier:claim.qualifier==="corroborated"?"attributed":claim.qualifier}))).slice(0,32);
            if(!claims.length)throw new Error("No source claims remain within spoiler policy");
            const aliasClaims=sources.flatMap(source=>source.aliasClaims.filter(permitted).map(claim=>({...claim,qualifier:claim.qualifier==="corroborated"?"attributed":claim.qualifier}))).slice(0,16);
            const freshUntil=Math.min(now+budget.briefFreshnessSeconds!*1000,...sources.map(source=>Date.parse(source.retrievedAt)+budget.briefFreshnessSeconds!*1000));
            const brief:UnderstandingRecord={...scope,schemaVersion:"1.0.0",recordType:"topicBrief",briefId:randomUUID(),revision:1,topicRef:topic,derived:true,status:"prepared",sources:sources.map(({content:_content,claims:_claims,aliasClaims:_aliases,knowledgeGaps:_gaps,topicRef:_topic,...source})=>({...source,kind:"providedFixture"})),claims,aliasClaims,knowledgeGaps:[...new Set(sources.flatMap(source=>source.knowledgeGaps))].slice(0,16),deeperMaterialRefs:[],builtAt:new Date().toISOString(),freshUntil:new Date(freshUntil).toISOString(),compilerRef:"provided-source-attribution:1",dependencyRefs,configurationRef};
            return brief;
          }],publish:brief=>this.repository.publish(scope,key,snapshot.boundary,[brief],()=>current())});
        if(!this.closed&&result.state!=="published")this.repository.finish(scope,key,result.state==="failed"?"failed":"cancelled",result.reason);
        if(!this.closed&&result.state==="published")this.host.changed();
      }).catch(()=>{if(!this.closed)this.repository.finish(scope,key,"failed","Preparation failed without publication or automatic retry.");}).finally(()=>this.tasks.delete(key));
      this.tasks.set(key,{relationshipId:scope.relationshipId,scope,promise});
      return this.response(scope,operation,[work],"Preparation admitted. Refresh to inspect its observed terminal result.",202);
    }catch(error){return extensionError(409,"discovery_admission_denied",error instanceof Error?error.message:"Discovery admission denied");}
  }
  private prepareAnalysis(scope:UnderstandingScope,request:Record<string,unknown>,snapshot:Snapshot,settings:Settings,authorizationCurrent:()=>boolean):Result {
    const selectedPort=this.host.analysis?.(),port=selectedPort?{...selectedPort}:undefined;
    if(!port||port.preemptionBoundMs===undefined||!Number.isFinite(port.preemptionBoundMs)||port.preemptionBoundMs<0||port.preemptionBoundMs>10)return extensionError(409,"provider_priority_unverified","Optional model analysis is withheld until shared-provider cancellation and next-turn latency are qualified. Supplied-source preparation remains available.");
    try {
      const budget=settings.budget,refs=request.evidenceRefs as string[],topic=String(request.topicRef);
      if(!refs.length||refs.length>24||!this.host.evidence||budget.analysisCallsPerJob!<1||!settings.policyRefs.length||settings.excludedTopicRefs.includes(topic))throw new Error("Current evidence, topic policy and analysis budget are required");
      if(settings.researchMode==="approvedTopics"&&!settings.approvedTopicRefs.includes(topic))throw new Error("Topic is not approved");
      if((request.sources as unknown[]).length)throw new Error("Prepare supplied sources separately; hypothesis analysis consumes scoped personal evidence without acquiring topic material");
      const evidence=this.host.evidence(scope,refs);if(evidence.length!==refs.length||new Set(refs).size!==refs.length||new Set(evidence.map(item=>item.ref)).size!==refs.length||evidence.some(item=>!refs.includes(item.ref)))throw new Error("Some selected evidence is unavailable");
      const current=()=>{const livePort=this.host.analysis?.();return !this.closed&&authorizationCurrent()&&snapshot.boundary===this.host.snapshot(scope).boundary&&livePort?.identity===port.identity&&livePort?.preemptionBoundMs===port.preemptionBoundMs&&this.host.evidenceAllowed(scope,refs)&&this.host.sourceAllowed(scope,topic)&&process.memoryUsage().heapUsed<budget.workerMemoryMiB!*1024*1024;};
      if(!current())throw new Error("Current analysis scope denied");
      const now=Date.now(),key=randomUUID(),configurationRef=`relationship-configuration:${snapshot.configuration!.configurationId}:${snapshot.configuration!.revision}`;
      const dependencyRefs=[`snapshot:${snapshot.boundary}`,`analysis-provider:${understandingDigest(port.identity)}`,...evidence.map(e=>`evidence:${e.ref}:${e.revision}`)];
      const work:UnderstandingRecord={...scope,schemaVersion:"1.0.0",recordType:"work",workId:key,revision:1,topicRef:topic,purpose:"hypothesisAnalysis",state:"queued",executionMode:"normal",idempotencyKey:request.idempotencyKey,configurationRef,policyRefs:settings.policyRefs,dependencyRefs,capabilityInvocationRef:null,admissionReceiptRef:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+budget.jobDeadlineSeconds!*1000).toISOString(),expiresAt:new Date(now+budget.pendingJobTtlSeconds!*1000).toISOString(),budget:structuredClone(budget),producedRefs:[],lastOutcome:"notRun",reason:"Queued bounded competing-hypothesis analysis; canonical user evidence remains unchanged."};
      const {idempotencyKey:_key,...semantic}=request;
      const admitted=this.repository.admit(scope,work,understandingDigest(request),understandingDigest([semantic,snapshot.boundary,port.identity]),snapshot.boundary,()=>current());
      if(admitted.replay)return this.response(scope,"prepare",[admitted.record],"Existing analysis admission; no repeated provider call.");
      const promise=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
        if(this.closed)return;
        const result=await this.coordinator.run({key,deadlineAt:Date.parse(String(work.deadlineAt)),current,admitOnce:()=>this.repository.start(scope,key),sharedInference:true,providerPreemptionBoundMs:port.preemptionBoundMs!,
          steps:[async signal=>(await analyzeDiscoveryEvidence({scope,topicRef:topic,workId:key,configurationRef,dependencyRefs,evidence,port,maximumOutputTokens:budget.outputTokensPerCall!,maximumInputBytes:Math.min(budget.inputBytesPerJob!,budget.sourceTokensPerJob!),deadlineAt:String(work.deadlineAt),signal,current})).record],
          publish:record=>this.repository.publish(scope,key,snapshot.boundary,[record],()=>current())});
        if(!this.closed&&result.state!=="published")this.repository.finish(scope,key,result.state==="failed"?"failed":"cancelled",result.reason);
        if(!this.closed&&result.state==="published")this.host.changed();
      }).catch(()=>{if(!this.closed)this.repository.finish(scope,key,"failed","Analysis failed without publication or automatic retry.");}).finally(()=>this.tasks.delete(key));
      this.tasks.set(key,{relationshipId:scope.relationshipId,scope,promise});return this.response(scope,"prepare",[work],"Analysis admitted. Its explanations remain tentative and require review.",202);
    }catch(error){return extensionError(409,"analysis_admission_denied",error instanceof Error?error.message:"Analysis admission denied");}
  }
  select(scope:UnderstandingScope,input:string,audience:"authenticatedSession"|"unknown",remainingBytes:number){
    const start=performance.now(),snapshot=this.host.snapshot(scope),settings=snapshot.configuration?.extensions?.understanding as Settings|undefined;
    const enabled=!!settings?.enabled&&audience==="authenticatedSession"&&!/\b(?:actually|instead|not|never|correction|stop)\b|don't|no longer/iu.test(input);
    const budget={tokens:Math.max(0,Math.min(settings?.budget.enrichmentTokens??0,remainingBytes-1)),items:settings?.budget.selectedItems??0,deadlineMs:settings?.budget.optionalSelectionDeadlineMs??10};
    let candidates:ReturnType<UnderstandingRepository["select"]>=[];
    try{if(enabled)candidates=this.repository.select(scope,snapshot.boundary,input);}catch{/* Optional index failure withholds enrichment; the ordinary reply remains available. */}
    const selected=selectPreparedEnrichment({candidates,enabled,budget,boundaryCurrent:()=>snapshot.boundary===this.host.snapshot(scope).boundary,now:()=>performance.now()});
    if(performance.now()-start>=budget.deadlineMs)return {...selected,items:[],content:"",tokenUpperBound:0,freshUntil:Date.now(),disposition:"deadline" as const};
    return {...selected,freshUntil:Math.min(Date.now()+120000,...candidates.filter(item=>selected.items.some(chosen=>chosen.id===item.id)).map(item=>item.freshUntil))};
  }
}
