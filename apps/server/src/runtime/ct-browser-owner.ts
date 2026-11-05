import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {AuthenticationError} from '../auth/local-auth.ts';

type Owner={close:()=>Promise<void>|void};
type Binding={identity:string;assertCurrent:()=>void};
/** One fixed selected job, not a session selector or an authentication service.
 * Request authentication stays in the original server; nothing here can mint it. */
export function createCtBrowserOwnerRendezvous<T extends Owner>(ports:{
 now:()=>number;expiresAt?:number;preparation?:'untilCancelled';signal?:AbortSignal;current:()=>void;
 qualify:(request:IncomingMessage)=>Binding;
 open:(request:IncomingMessage)=>T;
}){
 const untilCancelled=ports.preparation==='untilCancelled';
 if(untilCancelled?ports.expiresAt!==undefined||!(ports.signal instanceof AbortSignal):ports.preparation!==undefined||!Number.isFinite(ports.expiresAt))throw new AuthenticationError(409,'ct_browser_owner_lifetime_required');
 const expiresAt=untilCancelled?null:ports.expiresAt!;
 let armed=false,closed=false,consumed=false,last=ports.now(),pending:{challenge:string;expiresAt:number;binding:Binding}|null=null,owner:T|undefined,closingOwner:Promise<void>|undefined,closing:Promise<void>|undefined;
 let resolveOwner!:(owner:T)=>void,rejectOwner!:(error:unknown)=>void;
 const ownerReady=new Promise<T>((resolve,reject)=>{resolveOwner=resolve;rejectOwner=reject;});
 void ownerReady.catch(()=>{});
 const closeOwner=()=>closingOwner??=(owner?Promise.resolve().then(()=>owner!.close()):Promise.resolve());
 const refuse=(code:string):never=>{throw new AuthenticationError(409,code);};
 const current=()=>{const now=ports.now();if(closed||ports.signal?.aborted||!Number.isFinite(now)||now<last||expiresAt!==null&&now>=expiresAt)refuse('ct_browser_owner_closed');last=now;ports.current();return now;};
 const review=(request:IncomingMessage)=>{
  const now=current(),binding=ports.qualify(request);binding.assertCurrent();current();
  if(consumed)return {schemaVersion:'ct-browser-owner-review/1',state:'bound',canBind:false};
  if(!armed)return {schemaVersion:'ct-browser-owner-review/1',state:'waitingForWorker',canBind:false};
  pending={challenge:randomBytes(32).toString('hex'),expiresAt:Math.min(now+30000,expiresAt??Infinity),binding};
  return {schemaVersion:'ct-browser-owner-review/1',state:'reviewRequired',canBind:true,challenge:pending.challenge,expiresAt:new Date(pending.expiresAt).toISOString()};
 };
 const accept=(request:IncomingMessage,body:unknown)=>{
  const now=current();
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='challenge'||typeof (body as any).challenge!=='string'||!/^[a-f0-9]{64}$/.test((body as any).challenge))throw new AuthenticationError(422,'ct_browser_owner_closed_body_required');
  if(!armed||consumed||!pending||pending.expiresAt<=now||pending.challenge!==(body as any).challenge)refuse('ct_browser_owner_review_required');
  const reviewed=pending!,binding=ports.qualify(request);reviewed.binding.assertCurrent();binding.assertCurrent();
  if(binding.identity!==reviewed.binding.identity)refuse('ct_browser_owner_changed');
  current();consumed=true;pending=null;
  try{owner=ports.open(request);binding.assertCurrent();current();resolveOwner(owner);}
  catch(error){rejectOwner(error);void closeOwner().catch(()=>{});throw error;}
  return {schemaVersion:'ct-browser-owner-review/1',state:'bound',canBind:false,nativeStarted:false};
 };
 const api=Object.freeze({review,accept,capture(request:IncomingMessage){current();const binding=ports.qualify(request);binding.assertCurrent();return binding;},arm(){current();if(armed||consumed)refuse('ct_browser_owner_already_armed');armed=true;},owner:()=>ownerReady,
  close(){if(closing)return closing;closed=true;pending=null;ports.signal?.removeEventListener('abort',cancel);rejectOwner(new AuthenticationError(409,'ct_browser_owner_closed'));return closing=closeOwner();}});
 const cancel=()=>{void api.close().catch(()=>{});};
 if(ports.signal?.aborted)cancel();else ports.signal?.addEventListener('abort',cancel,{once:true});
 return api;
}
