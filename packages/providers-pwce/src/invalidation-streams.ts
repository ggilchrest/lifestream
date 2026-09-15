import { createHash, randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { createContractValidator } from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import { boundedJson, canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import { PwceCapabilityCatalog, PWCE_LIGHT_CAPABILITY_ID, modeMatches, validateBinding } from './capability-catalog.ts';
import type { PwceCapabilityBinding, PwceCapabilityCatalogOptions } from './capability-catalog.ts';
import { PwceScopedCache } from './cache.ts';
import type { PwceInvalidationEvent } from './client.ts';
import { PwceCallScope, PwceTransportError } from './transport.ts';

type Request = M.AuthorityInvalidationRequest | M.CapabilityInvalidationRequest;
type Event = M.AuthorityInvalidationEvent | M.CapabilityInvalidationEvent;
type Reason = 'gap' | 'catalogChanged' | 'providerChanged' | 'authorityChanged' | 'expired';
export type PwceInvalidationOptions = Pick<PwceCapabilityCatalogOptions,'providerRef'|'client'|'resolve'|'isCurrent'> & {
  catalog: PwceCapabilityCatalog; queueCapacity?: number; maximumSiteStreams?: number; watchDurationMs?: number; evidenceCapacity?: number;
  /** All scoped HTTP streams are connected; a host may now request fresh state. */
  onReady?(scope:M.CallScope,signal:AbortSignal):void;
};
export type PwceInvalidationEvidence = { eventId:string; scope:M.CallScope; binding:PwceCapabilityBinding; siteRef:string; source:Record<string,unknown> };
const validator=createContractValidator(), base='https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/';
const fail=(code:string):never=>{throw new PwceTransportError(code,`PWCE invalidation ${code}`);};
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const cursor=(value:unknown):number=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):fail('invalid_cursor');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function json(text:string):Record<string,unknown>{
  if(Buffer.byteLength(text)>65536)fail('invalid_event');
  let value:unknown;try{value=JSON.parse(text);}catch{return fail('invalid_event');}
  const stack:Array<{object:boolean;key:boolean;keys:Set<string>}>=[];let count=0;
  for(const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)){
    if(++count>8192)fail('invalid_event');
    const token=match[0],top=stack.at(-1);
    if(token==='{'||token==='['){if(stack.length>=32)fail('invalid_event');stack.push({object:token==='{',key:token==='{',keys:new Set()});}
    else if(token==='}'||token===']')stack.pop();
    else if(token===','&&top?.object)top.key=true;
    else if(token.startsWith('"')&&top?.object&&top.key){const key=JSON.parse(token) as string;if(top.keys.has(key))fail('invalid_event');top.keys.add(key);top.key=false;}
  }
  if(!object(value)||!boundedJson(value,65536))return fail('invalid_event');return value;
}
function resume(request:Request):number{
  const after=request.payload.afterSequence, revision=request.payload.sourceRevision;
  if(after!==null&&!Number.isSafeInteger(after))fail('invalid_cursor');
  if(revision){const n=cursor(revision.highWaterMark);if(revision.providerRef!==request.payload.providerRef||revision.revision!==String(n)||after!==null&&after!==n)fail('invalid_cursor');return n;}
  return after??0;
}
function boundedOption(value:number|undefined,fallback:number,max:number):number{const n=value??fallback;if(!Number.isInteger(n)||n<1||n>max)fail('invalid_configuration');return n;}

/** Read-only canonical notification adapter. It owns finite subscriptions, not
 * authority grants, durable actions or host activation. */
export class PwceInvalidationStreams {
  private readonly options:PwceInvalidationOptions;
  private readonly evidence=new Map<string,PwceInvalidationEvidence>();
  private activeSites=0;
  constructor(options:PwceInvalidationOptions){
    if(!options.providerRef||options.providerRef.length>500)fail('invalid_configuration');
    this.options={...options,queueCapacity:boundedOption(options.queueCapacity,128,1024),maximumSiteStreams:boundedOption(options.maximumSiteStreams,256,1024),watchDurationMs:boundedOption(options.watchDurationMs,10000,25000),evidenceCapacity:boundedOption(options.evidenceCapacity,256,4096)};
  }
  subscribeCapabilities(input:M.CapabilityInvalidationRequest,context:ProviderCallContext):AsyncGenerator<M.CapabilityInvalidationEvent>{return this.subscribe(input,context,'CapabilityInvalidationRequest') as AsyncGenerator<M.CapabilityInvalidationEvent>;}
  subscribeAuthority(input:M.AuthorityInvalidationRequest,context:ProviderCallContext):AsyncGenerator<M.AuthorityInvalidationEvent>{return this.subscribe(input,context,'AuthorityInvalidationRequest') as AsyncGenerator<M.AuthorityInvalidationEvent>;}
  private subscribe(input:Request,context:ProviderCallContext,definition:string):AsyncGenerator<Event>{
    if(!boundedJson(input)||!validator.validate(base+definition,input).valid||input.payload.providerRef!==this.options.providerRef||input.scope.authorityContextRef?.providerRef!==this.options.providerRef||!input.scope.endpointId||!input.scope.sessionId)fail('invalid_request');
    const request=structuredClone(input);resume(request);
    const lifetime=new AbortController(), signal=AbortSignal.any([context.signal,lifetime.signal]);
    const inner=this.run(request,{...context,signal});
    // return() must cancel an outstanding next(), even when a source ignores it.
    return {next:value=>inner.next(value),return:value=>{lifetime.abort();return inner.return(value);},throw:error=>{lifetime.abort();return inner.throw(error);},[Symbol.asyncIterator](){return this;}};
  }
  readEventEvidence(eventId:string,scope:M.CallScope,context:ProviderCallContext):PwceInvalidationEvidence|undefined{
    if(!boundedJson(scope))return undefined;
    const record=this.evidence.get(hash([scope,eventId]));
    if(!record||context.signal.aborted||!context.isCurrent(structuredClone(scope))||!this.options.isCurrent(structuredClone(record.binding),structuredClone(scope)))return undefined;
    return structuredClone(record);
  }
  private remember(record:PwceInvalidationEvidence):void{
    const key=hash([record.scope,record.eventId]);
    const previous=this.evidence.get(key);
    if(previous){if(hash(previous.source)!==hash(record.source)||hash(previous.binding)!==hash(record.binding))fail('event_identity_changed');return;}
    this.evidence.delete(key);this.evidence.set(key,structuredClone(record));
    while(this.evidence.size>this.options.evidenceCapacity!)this.evidence.delete(this.evidence.keys().next().value!);
  }
  private async *run(request:Request,context:ProviderCallContext):AsyncGenerator<Event>{
    const remaining=Date.parse(request.deadlineAt)-Date.now();
    if(!Number.isFinite(remaining)||remaining<=25||remaining>30000)fail('invalid_deadline');
    const outer=new PwceCallScope(remaining,context.signal), streamId=randomUUID();
    let binding:PwceCapabilityBinding|undefined, source:PwceCallScope|undefined, timer:ReturnType<typeof setTimeout>|undefined, guard:ReturnType<typeof setInterval>|undefined;
    let sequence=0, sites=0, active=0, released=false, failure:PwceTransportError|undefined;
    const queue:Event[]=[], changed=new Set<()=>void>(), cursors=new Map<string,number>(), seen=new Map<string,string>(), cursorIdentities=new Map<string,string>(), ready=new Set<string>();
    const notify=()=>{for(const done of changed)done();changed.clear();};
    const wait=()=>new Promise<void>(resolve=>changed.add(resolve));
    const invalidate=()=>this.options.catalog.invalidateAuthority(request.scope.authorityContextRef!);
    const current=()=>{outer.check();if(!context.isCurrent(structuredClone(request.scope))||binding&&!this.options.isCurrent(structuredClone(binding),structuredClone(request.scope)))fail('scope_changed');};
    const envelope=()=>({schemaVersion:'1.0.0' as const,operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:this.options.providerRef,streamId,sequence,occurredAt:new Date(Math.min(Date.now(),Date.parse(request.deadlineAt))).toISOString()});
    const release=()=>{clearTimeout(timer);clearInterval(guard);source?.close();if(!released){this.activeSites-=sites;released=true;}notify();};
    const emit=async(reason:Reason,eventId:string,occurredAt:string,siteRef:string,raw:Record<string,unknown>)=>{
      invalidate();current();
      while(queue.length>=this.options.queueCapacity!)await source!.wait(wait());
      source!.check();current();
      const header={...envelope(),occurredAt};
      const event:Event=request.operation==='CapabilityProvider.subscribeInvalidations'?{...header,operation:request.operation,kind:'data',payload:{eventId,scope:request.scope,snapshotIds:[],capabilityIds:[PWCE_LIGHT_CAPABILITY_ID],reason,occurredAt}}:
        {...header,operation:request.operation,kind:'data',payload:{eventId,scope:request.scope,providerRef:this.options.providerRef,authorityContextRef:request.scope.authorityContextRef!,reason:reason==='gap'||reason==='expired'?reason:'providerChanged',occurredAt}};
      if(!validator.validate(base+(request.operation.startsWith('Capability')?'CapabilityInvalidationEvent':'AuthorityInvalidationEvent'),event).valid)fail('invalid_event');
      this.remember({eventId,scope:request.scope,binding:binding!,siteRef,source:raw});queue.push(structuredClone(event));notify();
    };
    try{
      current();binding=structuredClone(await outer.wait(this.options.resolve(structuredClone(request.scope),request.executionMode,outer.signal)));validateBinding(binding);current();
      if(!modeMatches(request.executionMode,binding.executionEnvironmentRef))fail('execution_mode_mismatch');
      if(this.activeSites+binding.siteRefs.length>this.options.maximumSiteStreams!)fail('stream_capacity');
      sites=binding.siteRefs.length;this.activeSites+=sites;invalidate();
      source=new PwceCallScope(Math.max(1,Date.parse(request.deadlineAt)-Date.now()),outer.signal);
      setMaxListeners(sites*4+16,source.signal);
      source.signal.addEventListener('abort',()=>{invalidate();notify();},{once:true});
      timer=setTimeout(()=>source!.abort(new PwceTransportError('stream_rollover','PWCE bounded subscription completed')),Math.max(1,Math.min(this.options.watchDurationMs!,Date.parse(request.deadlineAt)-Date.now()-25)));
      guard=setInterval(()=>{try{current();}catch{source!.abort(new PwceTransportError('scope_changed','PWCE subscription owner changed'));}},50);
      const start=resume(request), scoped={...binding.identity,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,requestId:request.requestId,correlationId:request.correlationId};
      for(const siteRef of binding.siteRefs)cursors.set(siteRef,start);
      const pump=async(siteRef:string)=>{
        const cache=new PwceScopedCache<never>({...scoped,authorityContextRef:binding!.authorityContextRef,authorityExpiresAt:request.deadlineAt,siteRef,principalRef:binding!.principalRef,sessionId:request.scope.sessionId!,environmentId:request.scope.environmentId},{isCurrent:()=>{try{current();return true;}catch{return false;}}});
        cache.acceptReplay({events:[],nextCursor:String(start),resyncRequired:false,hasMore:false});
        const accept=async(frame:PwceInvalidationEvent)=>{
          source!.check();current();const raw=json(frame.data);
          if(frame.event==='resync.required'){
            if(raw.reason==='stream_lifetime_exceeded')return 'end';
            const reason=raw.reason==='authority_context_expired'?'expired':raw.reason==='authority_context_invalidated'||raw.reason==='authentication_failed'||raw.reason==='scope_denied'?'authorityChanged':'gap';
            await emit(reason,randomUUID(),new Date().toISOString(),siteRef,raw);fail(reason==='gap'?'resync_required':'authority_unavailable');
          }
          if(!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/UUID',raw.eventId).valid||typeof raw.occurredAt!=='string'||Date.parse(raw.occurredAt)>Date.now())return fail('invalid_event');
          const accepted=cache.accept(frame);
          if(accepted==='resync')fail('invalid_event');
          // A valid authority invalidation closes this cache but is still a fact
          // to deliver. Current producer access will be checked on reconnect.
          if(accepted==='closed'&&frame.event!=='authority.invalidated')fail('authority_unavailable');
          if(accepted!=='duplicate')cursors.set(siteRef,cursor(raw.cursor));
          const fingerprint=hash(raw),prior=seen.get(raw.eventId as string);
          if(prior&&prior!==fingerprint)fail('event_identity_changed');
          const atCursor=cursorIdentities.get(raw.cursor as string);
          if(atCursor&&atCursor!==fingerprint)fail('cursor_identity_changed');
          if(prior||accepted==='duplicate')return 'continue';
          seen.set(raw.eventId as string,fingerprint);if(seen.size>128)seen.delete(seen.keys().next().value!);
          cursorIdentities.set(raw.cursor as string,fingerprint);if(cursorIdentities.size>128)cursorIdentities.delete(cursorIdentities.keys().next().value!);
          const retained=this.evidence.get(hash([request.scope,raw.eventId]));
          if(retained&&(hash(retained.source)!==fingerprint||hash(retained.binding)!==hash(binding)))fail('event_identity_changed');
          const reason=frame.event==='capabilities.invalidated'?'catalogChanged':frame.event==='authority.invalidated'?'authorityChanged':frame.event==='provider.degraded'?'providerChanged':undefined;
          if(reason)await emit(reason,raw.eventId as string,raw.occurredAt,siteRef,raw);
          if(accepted==='closed')fail('authority_unavailable');
          return 'continue';
        };
        let iterator:AsyncIterator<PwceInvalidationEvent>|undefined;
        try{
          // RPC replay supplies an actual high-water mark even for a quiet site.
          // Opening SSE at that mark covers events accepted during the handoff.
          let more=true;
          while(more){
            const previous=cursors.get(siteRef)!;
            const raw=await source!.wait(this.options.client.request({...scoped,authorityContextRef:binding!.authorityContextRef,operation:'events.subscribe',siteRef,afterCursor:String(previous),limit:100,deadline:request.deadlineAt},source!.signal));current();
            if(!boundedJson(raw)||raw.profileId!=='pwce-agent-gateway.v1'||raw.profileVersion!=='1.0.0'||raw.requestId!==request.requestId||raw.correlationId!==request.correlationId||raw.worldRef!==binding!.worldRef||raw.executionEnvironmentRef!==binding!.executionEnvironmentRef||raw.principalRef!==binding!.principalRef||raw.siteRef!==siteRef||!Array.isArray(raw.events)||raw.events.length>100||typeof raw.resyncRequired!=='boolean'||typeof raw.hasMore!=='boolean')return fail('invalid_replay');
            const next=cursor(raw.nextCursor);
            if(raw.resyncRequired){
              cache.acceptReplay({events:raw.events,nextCursor:raw.nextCursor,resyncRequired:raw.resyncRequired,hasMore:raw.hasMore});cursors.set(siteRef,next);
              await emit('gap',randomUUID(),new Date().toISOString(),siteRef,raw);more=false;
            }else{
              if(next<previous||raw.hasMore&&(!raw.events.length||next<=previous))fail('invalid_replay');
              for(const value of raw.events){if(!object(value)||typeof value.type!=='string'||typeof value.cursor!=='string')return fail('invalid_event');await accept({event:value.type,id:value.cursor,data:JSON.stringify(value)});}
              if(next<cursors.get(siteRef)!)fail('invalid_replay');
              cache.acceptReplay({events:[],nextCursor:String(next),resyncRequired:false,hasMore:false});cursors.set(siteRef,next);more=raw.hasMore;
            }
          }
          iterator=this.options.client.subscribeInvalidations(binding!.authorityContextRef,siteRef,{scope:scoped,afterCursor:String(cursors.get(siteRef)),signal:source!.signal,onReady:()=>{source!.check();current();if(!ready.has(siteRef)){ready.add(siteRef);if(ready.size===sites)this.options.onReady?.(structuredClone(request.scope),source!.signal);}}})[Symbol.asyncIterator]();
          while(true){const next=await source!.wait(Promise.resolve(iterator.next()));if(next.done)fail('unexpected_eof');if(await accept(next.value)==='end'){if(!(await source!.wait(Promise.resolve(iterator.next()))).done)fail('invalid_terminal');return;}}
        }finally{cache.close();try{if(iterator?.return)void Promise.resolve(iterator.return()).catch(()=>{});}catch{/* Disposal cannot extend the budget. */}}
      };
      active=sites;
      for(const siteRef of binding.siteRefs)void pump(siteRef).catch(error=>{
        const safe=error instanceof PwceTransportError?error:new PwceTransportError('invalid_event','PWCE invalidation failed');
        if(safe.code!=='stream_rollover'){failure??=safe;source!.abort(safe);}
      }).finally(()=>{active--;if(!active)release();notify();});
      while(active||queue.length){
        current();
        if(queue.length){const event=queue.shift()!;event.sequence=sequence++;notify();yield event;}
        else await outer.wait(wait());
      }
      current();if(failure)throw failure;if(ready.size!==sites)fail('stream_unavailable');
      const minimum=Math.min(...cursors.values());
      yield {...envelope(),kind:'terminal',outcome:{status:'succeeded',payload:{lastSequence:Math.max(0,sequence-1),sourceRevision:{providerRef:this.options.providerRef,revision:String(minimum),highWaterMark:String(minimum)}},error:null}} as Event;
    }catch(error){
      const code=error instanceof PwceTransportError&&/^[a-z][a-z0-9_.-]{0,119}$/.test(error.code)?error.code:'unavailable';
      const rejected=['scope_changed','authority_unavailable','authority_context_expired','authority_context_invalidated','authentication_failed','scope_denied'].includes(code);
      const status=code==='cancelled'?'cancelled':code==='deadline_exceeded'?'timedOut':rejected?'rejected':'retryableFailure';
      yield {...envelope(),kind:'terminal',outcome:{status,payload:null,error:{code,message:`PWCE invalidation ${code}`,retryable:status==='retryableFailure',correlationId:request.correlationId,details:[]}}} as Event;
    }finally{
      release();outer.close();if(sites)invalidate();
    }
  }
}
