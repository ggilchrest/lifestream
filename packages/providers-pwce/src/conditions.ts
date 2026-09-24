import {isDeepStrictEqual} from 'node:util';
import {boundedJson,validateCapabilitySchema} from '@lifestream/runtime/capabilities/schema-validation';
import {PwceGatewayClient} from './client.ts';
import {PwceCallScope,PwceTransportError,boundedFetch,readJsonObject,checkStatus,transportLimit} from './transport.ts';
import {EXPECTED_PWCE_CONDITION_BUNDLE as contract,PWCE_CONDITION_REQUEST_SCHEMA,PWCE_CONDITION_RESPONSE_SCHEMA,PWCE_CONDITION_RECORD_SCHEMA} from './condition-bundle.ts';

export type PwceConditionIdentity={assistantRef:string;endpointRef:string;participantRefs:string[];audienceRef:string};
export type PwceConditionSelectors={sourceRef?:string;zoneRef?:string};
export type PwceConditionQualification={state:'qualified'|'uncertain'|'unavailable';confidence:number|null;limitations:string[];evidenceRefs:string[]};
export type PwceCondition={conditionRef:string;revision:number;sourceRef:string;worldRef:string;siteRef:string;zoneRef:string;eventClass:string;sourceRevision:number;status:'open'|'resolved'|'expired';transition:'open'|'update'|'resolve'|'expire';severity:'info'|'warning'|'critical';summary:string;occurredAt:string;receivedAt:string;updatedAt:string;freshUntil:string;expiresAt:string;freshness:'fresh'|'stale'|'expired';basis:'observed'|'derived'|'synthetic';qualification:PwceConditionQualification};
export type PwceConditionAcknowledgment={conditionRef:string;revision:number;acknowledgedAt:string};
export type PwceConditionResponse={profileId:string;profileVersion:string;operation:'snapshot'|'changes'|'acknowledge';status:'ok'|'resyncRequired';evaluatedAt:string;conditions:PwceCondition[];nextCursor:number;hasMore:boolean;resyncReason:null|'cursorExpired'|'cursorAhead';acknowledgment:PwceConditionAcknowledgment|null;replay:boolean};
export type PwceConditionOptions={baseUrl:string;token:string;worldRef:string;siteRef:string;replay?:boolean;fetchImpl?:typeof fetch;requestTimeoutMs?:number};
const fail=(code:string):never=>{throw new PwceTransportError(code,'Condition data is unavailable ('+code+').');};
const keys=(value:unknown,allowed:string[]):value is Record<string,unknown>=>boundedJson(value,contract.maximumRequestBytes)&&!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));

/** Qualified foreign projections only. This client neither admits output nor resolves conditions. */
export class PwceConditionClient{
  private readonly options:PwceConditionOptions;
  private readonly fetch:typeof fetch;
  private readonly gateway:PwceGatewayClient;
  private readonly timeoutMs:number;
  constructor(options:PwceConditionOptions){
    const url=new URL(options.baseUrl);
    if(url.pathname!=='/'||url.search||url.hash||!options.worldRef||!options.siteRef)throw Error('Condition endpoint requires an origin, World and site');
    this.timeoutMs=transportLimit(options.requestTimeoutMs,10000,30000);
    this.gateway=new PwceGatewayClient({...options,requestTimeoutMs:this.timeoutMs});
    this.options={...options,baseUrl:url.origin};this.fetch=options.fetchImpl??fetch;
  }
  private current(current:()=>boolean,scope:PwceCallScope):void{
    scope.check();let allowed=false;try{allowed=current()===true;}catch{/* Host scope loss is a safe denial. */}
    if(!allowed)fail('scope_invalidated');
  }
  private async validateResponse(value:Record<string,unknown>,request:Record<string,unknown>,scope:PwceCallScope):Promise<PwceConditionResponse>{
    // A permitted page can exceed the shared validator's per-value ceiling.
    // Validate its closed envelope and every record separately; retain the producer's total limit.
    if(!boundedJson(value,contract.maximumResponseBytes)||!Array.isArray(value.conditions)||value.conditions.length>contract.maximumConditionsPerResponse
      ||!await scope.wait(validateCapabilitySchema(PWCE_CONDITION_RESPONSE_SCHEMA,{...value,conditions:[]},scope.signal,false,131072)))return fail('invalid_condition_response');
    const result=value as Omit<PwceConditionResponse,'replay'>;
    if(result.operation!==request.operation)return fail('invalid_condition_operation');
    if(result.status==='resyncRequired'){
      if(request.operation!=='changes'||!result.resyncReason||result.conditions.length||result.hasMore||result.acknowledgment!==null)return fail('invalid_condition_resync');
      return {...result,replay:this.options.replay===true};
    }
    if(result.resyncReason!==null)return fail('invalid_condition_resync');
    if(request.operation==='acknowledge'){
      if(result.conditions.length||result.hasMore||!result.acknowledgment||result.acknowledgment.conditionRef!==request.conditionRef||result.acknowledgment.revision!==request.revision)return fail('invalid_condition_acknowledgment');
    }else if(result.acknowledgment!==null)return fail('invalid_condition_acknowledgment');
    if(request.operation==='snapshot'&&result.hasMore)return fail('incomplete_condition_snapshot');
    if(request.operation==='changes'&&(result.nextCursor<Number(request.afterCursor)||(result.hasMore||result.conditions.length>0)&&result.nextCursor===request.afterCursor||result.conditions.length>Number(request.limit??contract.maximumConditionsPerResponse)))return fail('invalid_condition_cursor');
    const revisions=new Map<string,number>();
    for(const condition of result.conditions){
      if(!await scope.wait(validateCapabilitySchema(PWCE_CONDITION_RECORD_SCHEMA,condition,scope.signal)))return fail('invalid_condition_record');
      if(condition.worldRef!==this.options.worldRef||condition.siteRef!==this.options.siteRef||request.sourceRef!==undefined&&condition.sourceRef!==request.sourceRef||request.zoneRef!==undefined&&condition.zoneRef!==request.zoneRef)return fail('invalid_condition_scope');
      if(condition.basis==='synthetic'&&this.options.replay!==true)return fail('synthetic_condition_requires_replay');
      const previous=revisions.get(condition.conditionRef);
      if(previous!==undefined&&(request.operation!=='changes'||condition.revision<=previous))return fail('invalid_condition_revision');
      revisions.set(condition.conditionRef,condition.revision);
      if(condition.status==='open'&&!['open','update'].includes(condition.transition)||condition.status==='resolved'&&condition.transition!=='resolve'||condition.status==='expired'&&condition.transition!=='expire'
        ||Date.parse(condition.freshUntil)>Date.parse(condition.expiresAt)||condition.freshness==='fresh'&&(Date.parse(condition.freshUntil)<=Date.parse(result.evaluatedAt)||Date.parse(condition.expiresAt)<=Date.parse(result.evaluatedAt)||condition.status==='expired'))return fail('invalid_condition_lifecycle');
    }
    return {...result,replay:this.options.replay===true};
  }
  private async call(operation:PwceConditionResponse['operation'],payload:Record<string,unknown>,identity:PwceConditionIdentity,current:()=>boolean,signal?:AbortSignal,selectors:PwceConditionSelectors={}):Promise<PwceConditionResponse>{
    if(!keys(identity,['assistantRef','endpointRef','participantRefs','audienceRef'])||!keys(selectors,['sourceRef','zoneRef'])||!boundedJson(payload,contract.maximumRequestBytes))return fail('invalid_condition_scope');
    const bound=structuredClone(identity),selected=structuredClone(selectors),scope=new PwceCallScope(this.timeoutMs,signal);
    const request:Record<string,unknown>={operation,...structuredClone(payload),authorityContextRef:'pending',worldRef:this.options.worldRef,executionEnvironmentRef:'normal',siteRef:this.options.siteRef,...bound,...selected,deadline:new Date(Date.now()+this.timeoutMs).toISOString()};
    try{
      this.current(current,scope);
      if(!await scope.wait(validateCapabilitySchema(PWCE_CONDITION_REQUEST_SCHEMA,request,scope.signal)))return fail('invalid_condition_request');
      const response=await boundedFetch(this.fetch,this.options.baseUrl+contract.routes.bundle,{headers:{authorization:'Bearer '+this.options.token}},scope),bundle=await readJsonObject(response,scope);checkStatus(response,bundle);
      if(!isDeepStrictEqual(bundle,contract))return fail('incompatible_condition_contract');
      this.current(current,scope);
      const authority=await scope.wait(this.gateway.authority([this.options.siteRef],scope.signal,bound));
      this.current(current,scope);request.authorityContextRef=authority.authorityContextRef;
      if(!await scope.wait(validateCapabilitySchema(PWCE_CONDITION_REQUEST_SCHEMA,request,scope.signal)))return fail('invalid_condition_scope');
      this.current(current,scope);
      const received=await boundedFetch(this.fetch,this.options.baseUrl+contract.routes.request,{method:'POST',headers:{authorization:'Bearer '+this.options.token,'content-type':'application/json',[contract.authentication.contractHeader]:contract.bundleDigest},body:JSON.stringify(request)},scope),value=await readJsonObject(received,scope);checkStatus(received,value);
      const result=await this.validateResponse(value,request,scope);this.current(current,scope);return result;
    }catch(error){scope.check();if(error instanceof PwceTransportError)throw error;return fail('condition_unavailable');}
    finally{scope.close();}
  }
  snapshot(identity:PwceConditionIdentity,current:()=>boolean,signal?:AbortSignal,selectors:PwceConditionSelectors={}){return this.call('snapshot',{},identity,current,signal,selectors);}
  changes(afterCursor:number,identity:PwceConditionIdentity,current:()=>boolean,signal?:AbortSignal,selectors:PwceConditionSelectors={},limit=100){return this.call('changes',{afterCursor,limit},identity,current,signal,selectors);}
  /** A transport receipt of one exact producer revision, never Human acknowledgment or resolution. */
  acknowledge(conditionRef:string,revision:number,identity:PwceConditionIdentity,current:()=>boolean,signal?:AbortSignal){return this.call('acknowledge',{conditionRef,revision},identity,current,signal);}
}
