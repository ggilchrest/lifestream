import {createHash} from 'node:crypto';
import {mobileInterpretationPin,mobileInterpretationRequest,mobileInterpretationResponse,mobileInterpretationMetadata,mobileInterpretationDigest,mobileInterpretationIntentDigest,mobileInterpretationLimits,type MobileInterpretationRequest,type MobileInterpretationPreviewRequest,type MobileInterpretationMutationRequest,type MobileInterpretationQuery,type MobileInterpretationSummary,type MobileInterpretationProvenance,type MobileInterpretationCandidate,type MobileInterpretationHistoryEntry,type MobileInterpretationResult,type MobileInterpretationMetadata} from '@lifestream/contracts/mobile-context-interpretation';
import {mobileControlRequest,mobileControlRequestDigest,type MobileControlRequest} from '@lifestream/contracts/mobile-context-control';
import {MobileControlError,type MobileContextRepository,type MobileAccess,type MobileEnrollment,type MobileInterpretationBoundary,type MobileInterpretationHistory} from '@lifestream/storage-sqlite';
import {sleepSessions,sleepSourceKey,type SleepEvidence} from '@lifestream/runtime/mobile-context/sleep';
import type {SleepSegment} from '@lifestream/contracts/mobile-context';

type RecordView=ReturnType<MobileContextRepository['query']>['records'][number];
type Snapshot={access:MobileAccess;query:MobileInterpretationQuery;boundary:MobileInterpretationBoundary;history:MobileInterpretationHistory;records:RecordView[];sleep:SleepEvidence[];keys:Map<string,string>;candidates:MobileInterpretationCandidate[];provenance:MobileInterpretationProvenance};
class Unavailable extends Error{constructor(readonly reason:Extract<MobileInterpretationResult,{state:'unavailable'|'incomplete'}>['reason'],readonly incomplete=false){super(reason);}}
const choiceDigest=(key:string)=>createHash('sha256').update(key).digest('hex');
const preference=(e:MobileEnrollment)=>e.configuration.preferredSource??null;
const limitations=['Changes the source preference for this owned namespace; the preview covers only the requested window.','Raw records, policy grants and other configuration are preserved.','Current policy/retention/source currency is required; this is not a sleep-quality score.'];
const sumLineage=(s:MobileInterpretationSummary)=>[...new Set(s.sessions.flatMap(x=>x.lineage))].sort();

/** Bounded interpretation journey over the existing query, summary and config owners. */
export class MobileInterpretationService{
 constructor(private readonly repository:MobileContextRepository){}
 private response(result:MobileInterpretationResult,status=200){
  let body=mobileInterpretationResponse({schemaVersion:'1.0.0',producerPin:mobileInterpretationPin,result});
  if(!body){result={state:'incomplete',reason:'boundedResponse',advice:'reduceWindow',limitations:['The complete comparison does not fit the bounded response. Reduce the window; do not infer settlement. Retain the original and reconcile.']};body=mobileInterpretationResponse({schemaVersion:'1.0.0',producerPin:mobileInterpretationPin,result});if(!body)throw Error('mobile_interpretation_response_invalid');}
  return {status,body};
 }
 private summary(snapshot:Snapshot,selected:string|null):MobileInterpretationSummary{
  const sessions=sleepSessions(snapshot.sleep,snapshot.query.startAt,snapshot.query.endAt,selected??undefined).map(({sourceKey,alternateSources,...rest})=>({...rest,sourceChoiceDigest:sourceKey===null?null:choiceDigest(sourceKey),alternateChoiceDigests:alternateSources.map(choiceDigest)})),known=sessions.filter(s=>s.asleepMs!==null);
  return {algorithmVersion:'sleep-union/1',timeBasis:'elapsedUTC',coverage:snapshot.sleep.length?'partial':'unknown',totalAsleepMs:known.length?known.reduce((n,s)=>n+s.asleepMs!,0):null,sessions,excludedNonSleepRecords:snapshot.records.filter(r=>r.recordType!=='SleepSegment').length,excludedNonOverlappingSleepRecords:snapshot.records.filter(r=>r.recordType==='SleepSegment'&&!snapshot.sleep.some(x=>x.recordId===r.recordId)).length,deduplication:'same-source-interval-union',limitations:['Recorded source stages are not physiological certainty; unknown and unobserved sleep are not zero.','Intervals are clipped to the requested instants; source zone/offset/date are retained separately in lineage.','Alternate sources do not add their durations to the selected timeline.']};
 }
 private load(actor:MobileAccess,query:MobileInterpretationQuery):Snapshot{
  if(!this.repository.interpretationEnabled)throw new Unavailable('unsupportedSchema');const enrollment=this.repository.enrollment(actor,query.enrollmentId);if(!enrollment.sourceNamespace||enrollment.endpointId!==actor.endpointId||enrollment.state==='unbound')throw new Unavailable('sourceUnavailable');
  const access=this.repository.captureSourcePolicy(actor,query.enrollmentId),boundary=this.repository.interpretationBoundary(access,query);if(boundary.rawRecords>200)throw new Unavailable('boundedRecords',true);
  const records:RecordView[]=[];let cursor:string|undefined;
  for(let page=0;page<mobileInterpretationLimits.queryPages;page++){
   const result=this.repository.query(access,{schemaVersion:'1.0.0',...query,pageSize:100,...(cursor?{cursor}:{})});records.push(...result.records);if(records.length>mobileInterpretationLimits.records)throw new Unavailable('boundedRecords',true);cursor=result.nextCursor??undefined;if(!cursor)break;
  }
  if(cursor)throw new Unavailable('boundedRecords',true);
  const start=Date.parse(query.startAt),end=Date.parse(query.endAt),sleep=records.filter(r=>r.recordType==='SleepSegment'&&Date.parse(r.record.startAt)<end&&Date.parse((r.record as SleepSegment).endAt)>start).map(r=>({...r,record:r.record as SleepSegment})),keys=new Map<string,string>(),counts=new Map<string,number>();
  for(const record of sleep){const key=sleepSourceKey(record.source),digest=choiceDigest(key);if(Buffer.byteLength(key)>1024)throw new Unavailable('sourceUnavailable');keys.set(digest,key);counts.set(digest,(counts.get(digest)??0)+1);}
  if(keys.size>mobileInterpretationLimits.candidates)throw new Unavailable('boundedCandidates',true);
  const candidates=[...keys].sort(([a],[b])=>a.localeCompare(b)).map(([digest,key])=>{const source=sleep.find(r=>sleepSourceKey(r.source)===key)!.source;return {choiceDigest:digest,originalApp:source.originalApp??null,originalDevice:source.originalDevice??null,recordCount:counts.get(digest)!};});
  const history=this.repository.interpretationHistory(access,query.enrollmentId),current=this.repository.interpretationBoundary(access,query);if(mobileInterpretationDigest(boundary)!==mobileInterpretationDigest(current)||!access.current())throw new Unavailable('stateChanged');
  const provenance:MobileInterpretationProvenance={datasetDigest:mobileInterpretationDigest(records),policyBindingDigest:mobileInterpretationDigest(access.sourcePolicy),sourceSafetyEpoch:boundary.sourceSafetyEpoch,readState:'boundedComplete',timeBasis:'elapsedUTC',records:sleep.map(r=>({recordId:r.recordId,choiceDigest:choiceDigest(sleepSourceKey(r.source)),startAt:r.record.startAt,endAt:r.record.endAt,stage:r.record.stage,classification:r.record.classification,originalOffsetMinutes:r.record.originalOffsetMinutes??null,timeZone:r.record.timeZone??null,sourceLocalDate:r.record.sourceLocalDate??null})),limitations:['Bounded complete means all currently readable records in this window were read; physiological/source coverage remains partial.','Timezone/offset/date are source metadata, not inferred from the host or device.','Measurement origin labels do not constitute privacy classification or consent.']};
  return {access,query,boundary,history,records,sleep,keys,candidates,provenance};
 }
 private reversible(snapshot:Snapshot,m:MobileInterpretationMetadata):boolean{
  const current=snapshot.boundary.enrollment,available=new Set(snapshot.sleep.map(r=>r.recordId));return m.revision===snapshot.history.revision&&preference(current)===m.afterPreference&&m.query.assistantId===snapshot.query.assistantId&&m.query.startAt===snapshot.query.startAt&&m.query.endAt===snapshot.query.endAt&&[...m.beforeLineage,...m.afterLineage].every(k=>available.has(k))&&(m.beforePreference===null||snapshot.keys.get(choiceDigest(m.beforePreference))===m.beforePreference);
 }
 private inspect(actor:MobileAccess,query:MobileInterpretationQuery){
  const snapshot=this.load(actor,query),e=snapshot.boundary.enrollment,history:MobileInterpretationHistoryEntry[]=snapshot.history.entries.map(({metadata:m,appliedSourceRevision})=>({operationId:m.operationId,revision:m.revision,previousRevision:m.previousRevision,kind:m.change.kind,reverseOf:m.change.kind==='reverse'?m.change.operationId:null,beforeChoiceDigest:m.beforePreference===null?null:choiceDigest(m.beforePreference),afterChoiceDigest:m.afterPreference===null?null:choiceDigest(m.afterPreference),appliedSourceRevision,beforeSummaryDigest:m.beforeSummaryDigest,afterSummaryDigest:m.afterSummaryDigest,reversible:this.reversible(snapshot,m)}));
  return this.response({state:'inspected',query,target:{scope:{principalId:e.principalId,collector:e.collector,sourceNamespace:e.sourceNamespace!},endpointId:e.endpointId,enrollmentId:e.enrollmentId,assistantId:query.assistantId},sourceRevision:e.revision,interpretationRevision:snapshot.history.revision,preferredChoiceDigest:preference(e)===null?null:choiceDigest(preference(e)!),candidates:snapshot.candidates,summary:this.summary(snapshot,preference(e)),provenance:snapshot.provenance,history,historyCoverage:snapshot.history.coverage,limitations:[...limitations,'History covers this interpretation owner, not arbitrary earlier configuration edits.']});
 }
 private preview(actor:MobileAccess,r:MobileInterpretationPreviewRequest|MobileInterpretationMutationRequest){
  const snapshot=this.load(actor,r.query),e=snapshot.boundary.enrollment;if(e.revision!==r.expectedSourceRevision||snapshot.history.revision!==r.expectedInterpretationRevision)throw new Unavailable('stateChanged');if(!snapshot.keys.size)throw new Unavailable('sourceUnavailable');
  let afterPreference:string|null;
  if(r.change.kind==='select'){afterPreference=r.change.choiceDigest===null?null:snapshot.keys.get(r.change.choiceDigest)??null;if(r.change.choiceDigest!==null&&afterPreference===null)throw new Unavailable('sourceUnavailable');}
  else{const latest=snapshot.history.entries[0]?.metadata;if(!latest||latest.operationId!==r.change.operationId||!this.reversible(snapshot,latest))throw new Unavailable('sourceRevoked');afterPreference=latest.beforePreference;}
  if(afterPreference===preference(e))throw new Unavailable('noChange');const {preferredSource,...configuration}=e.configuration,newConfiguration={...configuration,...(afterPreference===null?{}:{preferredSource:afterPreference})};
  const original=mobileControlRequest({schemaVersion:'1.0.0',operationId:r.operationId,target:{principalId:e.principalId,endpointId:e.endpointId,collector:e.collector,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,expectedRevision:e.revision},action:{kind:'configure',state:e.state,configuration:newConfiguration}});if(!original||original.action.kind!=='configure')throw new Unavailable('sourceUnavailable');
  const before=this.summary(snapshot,preference(e)),after=this.summary(snapshot,afterPreference),controlDigest=mobileControlRequestDigest(original)!,intentDigest=mobileInterpretationIntentDigest(r),beforeSummaryDigest=mobileInterpretationDigest(before),afterSummaryDigest=mobileInterpretationDigest(after),frame={intentDigest,controlOriginal:original,beforeSummaryDigest,afterSummaryDigest,provenance:snapshot.provenance,readBoundaryDigest:snapshot.boundary.readBoundaryDigest,denialBoundaryDigest:snapshot.boundary.denialBoundaryDigest},reviewDigest=mobileInterpretationDigest(frame);
  const result={state:'ready' as const,operationId:r.operationId,query:r.query,target:{scope:{principalId:e.principalId,collector:e.collector,sourceNamespace:e.sourceNamespace!},endpointId:e.endpointId,enrollmentId:e.enrollmentId,assistantId:r.query.assistantId},sourceRevision:e.revision,interpretationRevision:snapshot.history.revision,nextInterpretationRevision:snapshot.history.revision+1,change:r.change,beforeChoiceDigest:preference(e)===null?null:choiceDigest(preference(e)!),afterChoiceDigest:afterPreference===null?null:choiceDigest(afterPreference),before,after,provenance:snapshot.provenance,reviewDigest,controlOriginal:original,limitations:[...limitations,'Latest reversal requires the reviewed window, Assistant and current lineage; it recomputes numbers rather than restoring an old numeric result.']};
  if(!mobileInterpretationResponse({schemaVersion:'1.0.0',producerPin:mobileInterpretationPin,result}))throw new Unavailable('boundedResponse',true);
  const metadata=mobileInterpretationMetadata({schemaVersion:'1.0.0',operationId:r.operationId,scope:result.target.scope,query:r.query,change:r.change,revision:result.nextInterpretationRevision,previousRevision:snapshot.history.revision,baseSourceRevision:e.revision,beforePreference:preference(e),afterPreference,beforeLineage:sumLineage(before),afterLineage:sumLineage(after),datasetDigest:snapshot.provenance.datasetDigest,readBoundaryDigest:snapshot.boundary.readBoundaryDigest,policyBindingDigest:snapshot.provenance.policyBindingDigest,sourceSafetyEpoch:snapshot.provenance.sourceSafetyEpoch,denialBoundaryDigest:snapshot.boundary.denialBoundaryDigest,intentDigest,reviewDigest,controlDigest,beforeSummaryDigest,afterSummaryDigest,algorithmVersion:'sleep-union/1'});if(!metadata)throw new Unavailable('historyUnavailable');
  return {snapshot,original,result,metadata,afterEnrollment:{...e,revision:e.revision+1,configuration:newConfiguration}};
 }
 private reconcile(actor:MobileAccess,original:MobileControlRequest){
  const controlResponse=this.repository.reconcileControl(actor,original),metadata=this.repository.interpretationOperation(actor,original),status=metadata?controlResponse.result.status:'unavailable';
  return this.response({state:'mutation',controlResponse,interpretationStatus:status,interpretationRevision:metadata&&status==='applied'?metadata.revision:null,operationId:original.operationId,limitations:['Control settlement alone is not proof of interpretation history; this status checks the same bound metadata row.','Historical metadata is not current data-use authority; no numeric result is replayed.']});
 }
 handle(actor:MobileAccess,input:unknown){
  const r=mobileInterpretationRequest(input);if(!r)throw new MobileControlError('invalid',422);
  try{
   if(r.operation==='reconcile')return this.reconcile(actor,r.controlOriginal);
   if(r.operation==='inspect')return this.inspect(actor,r.query);
   if(r.operation==='preview')return this.response(this.preview(actor,r).result);
   if(r.controlOriginal.target.endpointId!==actor.endpointId||r.controlOriginal.target.principalId!==actor.principalId)throw new MobileControlError('scope',403);
   const previous=this.repository.interpretationOperation(actor,r.controlOriginal);if(previous){if(previous.reviewDigest!==r.reviewDigest||previous.intentDigest!==mobileInterpretationIntentDigest(r))throw new MobileControlError('conflict',409);return this.reconcile(actor,r.controlOriginal);}
   const prepared=this.preview(actor,r);if(prepared.result.reviewDigest!==r.reviewDigest||mobileControlRequestDigest(prepared.original)!==mobileControlRequestDigest(r.controlOriginal))throw new MobileControlError('conflict',409);
   const guarded=this.repository.interpretationAccess(prepared.snapshot.access,r.query,prepared.snapshot.boundary,prepared.afterEnrollment,[...new Set([...prepared.metadata.beforeLineage,...prepared.metadata.afterLineage])],{operationId:r.operationId,reviewDigest:prepared.metadata.reviewDigest});
   const reserved=this.repository.reserveControl(guarded,prepared.original,prepared.metadata);if(reserved.created)this.repository.completeReservedControl(guarded,prepared.original);return this.reconcile(actor,prepared.original);
  }catch(error){
   if(error instanceof MobileControlError)throw error;if(error instanceof Unavailable)return this.response({state:error.incomplete?'incomplete':'unavailable',reason:error.reason,advice:error.incomplete?'reduceWindow':error.reason==='stateChanged'?'refresh':error.reason==='noChange'?'chooseDifferent':'unavailable',limitations:['No interpretation mutation was acknowledged. Current policy, data and source evidence are required.']},error.reason==='stateChanged'?409:200);
   return this.response({state:'unavailable',reason:'policyUnavailable',advice:'unavailable',limitations:['The actual source/policy/history owner could not establish current authorized data. Nothing is inferred from a missing decision.']});
  }
 }
}
