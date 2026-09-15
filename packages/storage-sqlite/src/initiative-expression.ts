import {createHash} from 'node:crypto';
import type {Database} from './database.ts';
import type {InitiativeScope} from './initiative-delivery.ts';

export type InitiativeExpression={
 requestedWarmth:number;modality:'text'|'speech';wording:'requested'|'emitted';
 speechStage:'notRequested'|'notObserved'|'providerReported'|'audioEmitted'|'synthesized';
 mappingRevision:string|null;disposition:'notObserved'|'fullyApplied'|'partiallyApplied'|'providerFailure'|'cancelled'|'timedOut';
 degradedDimensions:string[];appliedDelivery:{deliveryMode?:string;pace?:number;energy?:number};
};
export type InitiativeExpressionObservation={opportunityId:string;revision:number;observedAt:string;report:InitiativeExpression};
const scopeKey=(scope:InitiativeScope)=>createHash('sha256').update(JSON.stringify([scope.assistantId,scope.userId,scope.relationshipId,scope.deploymentId])).digest('hex');
const stages=['notRequested','notObserved','providerReported','audioEmitted','synthesized'];
const modes=['neutral','explanation','reassurance','concern','celebration','warning','emergency'];
function validate(report:InitiativeExpression){
 const keys=['requestedWarmth','modality','wording','speechStage','mappingRevision','disposition','degradedDimensions','appliedDelivery'];
 if(Object.keys(report).length!==keys.length||Object.keys(report).some(k=>!keys.includes(k))||!Number.isFinite(report.requestedWarmth)||report.requestedWarmth<0||report.requestedWarmth>1||!['text','speech'].includes(report.modality)||!['requested','emitted'].includes(report.wording)||!stages.includes(report.speechStage)||!['notObserved','fullyApplied','partiallyApplied','providerFailure','cancelled','timedOut'].includes(report.disposition))throw new Error('Invalid expression observation');
 if(report.mappingRevision!==null&&(typeof report.mappingRevision!=='string'||!/^[a-zA-Z0-9._:/@+-]{1,200}$/u.test(report.mappingRevision)))throw new Error('Invalid expression mapping reference');
 if(!Array.isArray(report.degradedDimensions)||report.degradedDimensions.length>32||new Set(report.degradedDimensions).size!==report.degradedDimensions.length||report.degradedDimensions.some(d=>typeof d!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(d)))throw new Error('Invalid expression dimensions');
 const applied=report.appliedDelivery;if(!applied||Array.isArray(applied)||typeof applied!=='object'||Object.keys(applied).some(k=>!['deliveryMode','pace','energy'].includes(k))||applied.deliveryMode!==undefined&&!modes.includes(applied.deliveryMode)||(['pace','energy'] as const).some(k=>applied[k]!==undefined&&(!Number.isFinite(applied[k])||applied[k]!<0||applied[k]!>1)))throw new Error('Invalid applied expression controls');
 if(report.modality==='text'&&(report.speechStage!=='notRequested'||report.mappingRevision!==null||report.disposition!=='notObserved'||report.degradedDimensions.length||Object.keys(applied).length)||report.modality==='speech'&&report.speechStage==='notRequested'||report.speechStage==='notObserved'&&(report.mappingRevision!==null||report.disposition!=='notObserved'||report.degradedDimensions.length||Object.keys(applied).length))throw new Error('Expression observation contradicts its stage');
 if(Buffer.byteLength(JSON.stringify(report),'utf8')>4096)throw new Error('Expression observation is too large');
}
/** Owner-local metadata, joined to the delivery record and its deletion horizon. */
export class InitiativeExpressionRepository {
 private readonly database:Database;private readonly now:()=>number;
 constructor(database:Database,now=Date.now){this.database=database;this.now=now;}
 get(scope:InitiativeScope,opportunityId:string):InitiativeExpressionObservation|undefined{
  const row=this.database.connection.prepare('SELECT e.* FROM initiative_expression e JOIN initiative_delivery d ON d.opportunity_id=e.opportunity_id WHERE e.opportunity_id=? AND e.scope_key=? AND d.scope_key=e.scope_key').get(opportunityId,scopeKey(scope)) as {revision:number;observed_ms:number;report_json:string}|undefined;
  return row?{opportunityId,revision:row.revision,observedAt:new Date(row.observed_ms).toISOString(),report:JSON.parse(row.report_json)}:undefined;
 }
 note(scope:InitiativeScope,opportunityId:string,report:InitiativeExpression,current:()=>boolean):InitiativeExpressionObservation{
  validate(report);const encoded=JSON.stringify(report),key=scopeKey(scope);
  return this.database.transaction(tx=>{
   const row=tx.get<{state:string;outcome_json:string;expires_ms:number}>('SELECT state,outcome_json,expires_ms FROM initiative_delivery WHERE opportunity_id=? AND scope_key=?',opportunityId,key);
   if(!row||current()!==true)throw new Error('Expression scope is unavailable');
   const prior=this.get(scope,opportunityId),now=this.now();if(!Number.isSafeInteger(now)||now<0||prior&&now<Date.parse(prior.observedAt))throw new Error('Expression clock discontinuity');
   if(now>=row.expires_ms)throw new Error('Expression opportunity expired');
   if(!['pending','eligible','generated','queued','emitted','acknowledged'].includes(row.state))throw new Error('Expression opportunity is terminal');
   const outcome=JSON.parse(row.outcome_json);if(report.wording==='emitted'&&!['emitted','acknowledged'].includes(outcome.lastDeliveryStage)||['audioEmitted','synthesized'].includes(report.speechStage)&&report.wording!=='emitted')throw new Error('Expression emission is unobserved');
   if(prior&&(prior.report.requestedWarmth!==report.requestedWarmth||prior.report.modality!==report.modality||prior.report.wording==='emitted'&&report.wording!=='emitted'||stages.indexOf(report.speechStage)<stages.indexOf(prior.report.speechStage)||prior.report.mappingRevision!==null&&prior.report.mappingRevision!==report.mappingRevision||prior.report.degradedDimensions.some(d=>!report.degradedDimensions.includes(d))||Object.entries(prior.report.appliedDelivery).some(([k,v])=>report.appliedDelivery[k as keyof InitiativeExpression['appliedDelivery']]!==v)))throw new Error('Expression observation cannot regress');
   const revision=(prior?.revision??0)+1;tx.run('INSERT INTO initiative_expression VALUES (?,?,?,?,?) ON CONFLICT(opportunity_id) DO UPDATE SET revision=excluded.revision,observed_ms=excluded.observed_ms,report_json=excluded.report_json',opportunityId,key,revision,now,encoded);
   return {opportunityId,revision,observedAt:new Date(now).toISOString(),report:structuredClone(report)};
  });
 }
}
