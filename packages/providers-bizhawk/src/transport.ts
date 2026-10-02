import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Duplex} from 'node:stream';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter,GameCallContext} from './port.js';
import {guardGameActivityAdapter,type GameAdapterBoundaryOptions} from './provider.ts';

const MAX_FRAME=131072,MAX_REQUESTS=256,MAX_PENDING=8;
const protocol='lifestream-game-control/1';
type Request=G.GameObserveRequest|G.GameActionRequest|G.GameReleaseRequest|G.GameSaveRequest;
type Result=G.GameObserveResult|G.GameActionResult|G.GameReleaseResult|G.GameSaveResult;
export class GameTransportError extends Error{
 readonly code:'invalidFrame'|'authenticationFailed'|'disconnected'|'closed'|'capacity'|'invalidResponse'|'scopeChanged'|'cancelled'|'timedOut';
 constructor(code:GameTransportError['code']){super('Game transport '+code);this.code=code;}
}
/** The referenced native socket API prefixes UTF-8 BYTES, not JS characters.
 * This control lane accepts text only. Screenshots need separate custody. */
export function encodeGameControlFrame(text:string):Buffer{
 const payload=Buffer.from(text,'utf8');
 if(payload.length<1||payload.length>MAX_FRAME||new TextDecoder('utf-8',{fatal:true}).decode(payload)!==text)throw new GameTransportError('invalidFrame');
 return Buffer.concat([Buffer.from(String(payload.length)+' ','ascii'),payload]);
}
/** Incremental, finite allocation even when a peer never completes a frame. */
export class GameControlFrameDecoder{
 private header='';private payload:Buffer|null=null;private offset=0;private closed=false;
 private readonly receive:(text:string)=>void;
 constructor(receive:(text:string)=>void){this.receive=receive;}
 push(chunk:Uint8Array):void{
  if(this.closed||chunk.byteLength>MAX_FRAME*2)throw new GameTransportError('invalidFrame');
  try{let at=0;while(at<chunk.byteLength&&!this.closed){
   if(this.payload===null){const byte=chunk[at++]!;
    if(byte===32){const length=Number(this.header);if(!/^[1-9][0-9]{0,5}$/.test(this.header)||length>MAX_FRAME)throw new GameTransportError('invalidFrame');this.payload=Buffer.alloc(length);this.header='';this.offset=0;}
    else{if(byte<48||byte>57||this.header.length>=6)throw new GameTransportError('invalidFrame');this.header+=String.fromCharCode(byte);}
   }else{const count=Math.min(this.payload.length-this.offset,chunk.byteLength-at);this.payload.set(chunk.subarray(at,at+count),this.offset);at+=count;this.offset+=count;
    if(this.offset===this.payload.length){const payload=this.payload;this.payload=null;this.offset=0;let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(payload);}finally{payload.fill(0);}this.receive(text);}
   }
  }}catch{this.dispose();throw new GameTransportError('invalidFrame');}
 }
 finish():void{const truncated=this.header!==''||this.payload!==null;this.dispose();if(truncated)throw new GameTransportError('invalidFrame');}
 dispose():void{this.closed=true;this.header='';this.payload?.fill(0);this.payload=null;this.offset=0;}
}
export interface GameTransportOptions{
 /** An explicitly paired local bridge credential. Never sourced from the game,
  * model, network address or a default. The caller retains its own copy. */
 pairingSecret:Uint8Array;scope:G.ActivityScope;pinsDigest:string;
 authenticationTimeoutMs:number;sessionDurationMs:number;
 boundary:GameAdapterBoundaryOptions;
 /** Host must fence input ownership and pursue actual pause on channel loss.
  * Calling this notification does not prove pause or effect resolution. */
 onDisconnect:(code:GameTransportError['code'])=>void;
}
export interface AuthenticatedGameTransport{adapter:GameActivityAdapter;ready:Promise<void>;close:()=>void;}
/** Operates only an already connected stream supplied by an authorized host.
 * No listener, launch, reconnect, automatic retry or native effect is created.
 * The peer still needs a reviewed Lua bridge and installed-build qualification. */
export function createAuthenticatedGameTransport(stream:Duplex,options:GameTransportOptions):AuthenticatedGameTransport{
 const valid=createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/ActivityScope',options.scope).valid;
 if(!valid||options.pairingSecret.byteLength<32||options.pairingSecret.byteLength>128||!/^[a-f0-9]{64}$/.test(options.pinsDigest)||!Number.isSafeInteger(options.authenticationTimeoutMs)||options.authenticationTimeoutMs<1||options.authenticationTimeoutMs>10000||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<options.authenticationTimeoutMs||options.sessionDurationMs>600000||typeof options.onDisconnect!=='function')throw new GameTransportError('authenticationFailed');
 const scope=structuredClone(options.scope),pinsDigest=options.pinsDigest,secret=Buffer.from(options.pairingSecret),providerRef=options.boundary.providerRef;
 const challenge={type:'challenge',protocol,sessionId:randomUUID(),nonce:randomBytes(32).toString('hex'),providerRef,pinsDigest,scopeDigest:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),expiresAt:new Date(Date.now()+options.authenticationTimeoutMs).toISOString()};
 const expected=createHmac('sha256',secret).update(JSON.stringify(challenge)).digest();secret.fill(0);
 const hostProof=createHmac('sha256',options.pairingSecret).update(protocol+' host '+JSON.stringify(challenge)).digest();
 let state:'authenticating'|'ready'|'closed'='authenticating',readyResolve!:()=>void,readyReject!:(e:Error)=>void,authTimer:ReturnType<typeof setTimeout>|undefined,sessionTimer:ReturnType<typeof setTimeout>|undefined;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
 type Entry={operation:Request['operation'];correlationId:string;phase:'pending'|'abandoned'|'delivered';resolve:(r:Result)=>void;reject:(e:Error)=>void;cleanup:()=>void};
 const entries=new Map<string,Entry>();
 const fail=(code:GameTransportError['code'])=>{
  if(state==='closed')return;state='closed';clearTimeout(authTimer);clearTimeout(sessionTimer);expected.fill(0);hostProof.fill(0);decoder.dispose();
  stream.off('data',onData);stream.off('end',onEnd);stream.off('close',onClose);stream.off('error',onError);stream.on('error',()=>{});
  const error=new GameTransportError(code);readyReject(error);for(const entry of entries.values()){entry.cleanup();if(entry.phase==='pending')entry.reject(error);}entries.clear();stream.destroy();try{options.onDisconnect(code);}catch{}
 };
 const send=(text:string)=>{
  const frame=encodeGameControlFrame(text);if(stream.destroyed||!stream.writable||stream.writableLength+frame.byteLength>MAX_FRAME*2){fail('capacity');throw new GameTransportError('capacity');}
  try{stream.write(frame,error=>{if(error)fail('disconnected');});}catch{fail('disconnected');throw new GameTransportError('disconnected');}
 };
 const decoder=new GameControlFrameDecoder(text=>{
  let message:any;try{message=JSON.parse(text);}catch{fail('invalidResponse');return;}
  if(state==='authenticating'){
   const exact=message&&typeof message==='object'&&!Array.isArray(message)&&Object.keys(message).length===2&&message.type==='authenticate'&&typeof message.proof==='string'&&/^[a-f0-9]{64}$/.test(message.proof)&&text===JSON.stringify({type:'authenticate',proof:message.proof});
   if(!exact||Date.now()>=Date.parse(challenge.expiresAt)||!timingSafeEqual(Buffer.from(message.proof,'hex'),expected)){fail('authenticationFailed');return;}
   expected.fill(0);clearTimeout(authTimer);state='ready';send(JSON.stringify({type:'authenticated',protocol,sessionId:challenge.sessionId,proof:hostProof.toString('hex')}));hostProof.fill(0);readyResolve();return;
  }
  if(state==='closed')return;
  const entry=message&&typeof message==='object'&&!Array.isArray(message)&&typeof message.requestId==='string'?entries.get(message.requestId):undefined;
  if(!entry||message.operation!==entry.operation||message.correlationId!==entry.correlationId||message.providerRef!==providerRef||entry.phase==='delivered'){fail('invalidResponse');return;}
  // One late reply for a specifically abandoned call may be discarded. It
  // cannot become a successor's result or evidence of reconciled execution.
  if(entry.phase==='abandoned'){entry.phase='delivered';return;}
  entry.phase='delivered';entry.cleanup();entry.resolve(message as Result);
 });
 const onData=(chunk:Buffer)=>{try{decoder.push(chunk);}catch{fail('invalidFrame');}};
 const onEnd=()=>{try{decoder.finish();fail('disconnected');}catch{fail('invalidFrame');}};
 const onClose=()=>fail('disconnected'),onError=()=>fail('disconnected');
 stream.on('data',onData);stream.on('end',onEnd);stream.on('close',onClose);stream.on('error',onError);
 authTimer=setTimeout(()=>fail('authenticationFailed'),options.authenticationTimeoutMs);sessionTimer=setTimeout(()=>fail('timedOut'),options.sessionDurationMs);
 async function call(request:Request,context:GameCallContext):Promise<Result>{
  if(state==='closed')throw new GameTransportError('closed');
  if(!isDeepStrictEqual(request.scope,scope)||request.operation!=='GameActivityAdapter.releaseControls'&&request.payload.expectedPinsDigest!==pinsDigest)throw new GameTransportError('scopeChanged');
  const remaining=Date.parse(request.deadlineAt)-Date.now(),monoDeadline=performance.now()+remaining;
  const check=()=>{if(context.signal.aborted)throw new GameTransportError('cancelled');if(Date.now()>=Date.parse(request.deadlineAt)||performance.now()>=monoDeadline)throw new GameTransportError('timedOut');if(!context.isCurrent(scope))throw new GameTransportError('scopeChanged');if(state==='closed')throw new GameTransportError('closed');
   // Authentication is an await boundary. A pre-handshake admission cannot
   // become permission to write after source/policy or finite authority changes.
   if(request.operation!=='GameActivityAdapter.releaseControls'&&!options.boundary.sourceAvailable(scope,pinsDigest))throw new GameTransportError('scopeChanged');
   if(request.operation==='GameActivityAdapter.applyController'||request.operation==='GameActivityAdapter.controlSave'){if(Date.now()>=Date.parse(request.payload.admission.expiresAt))throw new GameTransportError('scopeChanged');}
   if(request.operation==='GameActivityAdapter.applyController'&&Date.now()>=Date.parse(request.payload.dispatchValidation.preparedContextFreshUntil))throw new GameTransportError('scopeChanged');
  };
  check();if(entries.has(request.requestId)||entries.size>=MAX_REQUESTS+(request.operation==='GameActivityAdapter.releaseControls'?1:0))throw new GameTransportError('capacity');
  const pending=[...entries.values()].filter(e=>e.phase==='pending').length;
  if(pending>=MAX_PENDING+(request.operation==='GameActivityAdapter.releaseControls'?1:0))throw new GameTransportError('capacity');
  return new Promise<Result>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);};
   const abandon=(code:GameTransportError['code'])=>{if(entry.phase!=='pending')return;entry.phase='abandoned';cleanup();reject(new GameTransportError(code));};
   const abort=()=>abandon('cancelled');
   const entry:Entry={operation:request.operation,correlationId:request.correlationId,phase:'pending',resolve,reject,cleanup};entries.set(request.requestId,entry);
   context.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>abandon('timedOut'),Math.max(1,remaining));
   void ready.then(()=>{if(entry.phase!=='pending')return;try{check();send(JSON.stringify(request));}catch(error){entry.phase='abandoned';cleanup();reject(error instanceof GameTransportError?error:new GameTransportError('scopeChanged'));}},()=>{if(entry.phase==='pending')abandon('authenticationFailed');});
   if(context.signal.aborted)abort();
  });
 }
 const wire:GameActivityAdapter={observe:(r,c)=>call(r,c) as Promise<G.GameObserveResult>,applyController:(r,c)=>call(r,c) as Promise<G.GameActionResult>,releaseControls:(r,c)=>call(r,c) as Promise<G.GameReleaseResult>,controlSave:(r,c)=>call(r,c) as Promise<G.GameSaveResult>};
 let adapter:GameActivityAdapter;try{adapter=guardGameActivityAdapter(wire,options.boundary);send(JSON.stringify(challenge));}catch(error){fail('authenticationFailed');throw error;}
 return {adapter,ready,close:()=>fail('closed')};
}
