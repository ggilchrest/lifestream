import {readNativeUbuntuFrameOwner} from './ubuntu-presence-host-factory.ts';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const failed=()=>Object.assign(Error('camera_presence_native_unavailable'),{code:'camera_presence_native_unavailable'});
const closed=(v,keys)=>!!v&&typeof v==='object'&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&Object.hasOwn(d,'value');});
const states=new Set(['stored','supported','uncertain','incomplete','unavailable']);
const wipeTransferred=value=>{try{const bytes=value&&Object.getOwnPropertyDescriptor(value,'bytes')?.value;if(bytes instanceof Uint8Array)Uint8Array.prototype.fill.call(bytes,0);}catch{}};

// This adapter can read only a constructor-registered original Ubuntu Host.
// It has no registrar, caller-current callback, browser deviceId or capture API.
export class UbuntuOwnedFrameBinding {
 #host;#active=new Map();#closed=false;
 constructor(host){if(!readNativeUbuntuFrameOwner(host))throw failed();this.#host=host;}
 async capture(context,channelId){
  if(this.#closed||this.#active.size>=4||this.#active.has(channelId))throw failed();
  const owner=readNativeUbuntuFrameOwner(this.#host),snapshot=owner?.snapshot(context,channelId);if(!owner||!snapshot)throw failed();
  const op={owner,snapshot,channelId,context:structuredClone(context),controller:new AbortController(),bytes:null,last:-Infinity,closed:false};this.#active.set(channelId,op);
  const current=()=>{
   if(this.#closed||op.closed||op.controller.signal.aborted||this.#active.get(channelId)!==op||readNativeUbuntuFrameOwner(this.#host)!==owner)return false;
   const at=owner.clock();if(!Number.isFinite(at)||at<op.last||at>=snapshot.capture.untilMonotonicMs)return false;
   const next=owner.snapshot(op.context,channelId);if(!next||!same(next,snapshot))return false;
   const lease=owner.broker.lease(snapshot.capture.lease.leaseId);owner.broker.assertLease(lease,snapshot.capture.lease.fencingToken);
   if(!same(lease,snapshot.capture.lease))return false;
   const resource=owner.broker.resource(snapshot.capture.grant.resourceId);
   if(resource.resourceId!==snapshot.capture.grant.resourceId||resource.kind!=='camera'||resource.health!=='healthy'||resource.removed||resource.permissionStatus!=='granted'||!resource.capabilities?.includes('capture'))return false;
   const end=owner.clock();
   if(!Number.isFinite(end)||end<at||end<op.last||end>=snapshot.capture.untilMonotonicMs||this.#closed||op.closed||op.controller.signal.aborted||this.#active.get(channelId)!==op||readNativeUbuntuFrameOwner(this.#host)!==owner)return false;
   op.last=end;return true;
  };
  const check=()=>{if(!current())throw failed();};
  const finish=()=>{if(op.closed)return;op.closed=true;op.controller.abort();op.bytes?.fill(0);if(this.#active.get(channelId)===op)this.#active.delete(channelId);};
  let timer,transferred;try{
   check();timer=setTimeout(finish,Math.max(1,Math.min(5000,snapshot.capture.untilMonotonicMs-op.last)));timer.unref?.();
   const received=owner.clock();check();
   if(!owner.bind(op.context,{channelId,challengeId:snapshot.challenge.id,endpointClockId:snapshot.challenge.id,endpointReceivedMonotonicMs:received}))throw failed();check();
   const g=snapshot.capture.grant,lease=snapshot.capture.lease;
   const sourceRequest=Object.freeze({resourceId:g.resourceId,leaseId:lease.leaseId,fencingToken:lease.fencingToken,purpose:g.purpose,expiresAt:g.authorityExpiresAt});
   const pending=Promise.resolve(owner.capture.call(owner.source,sourceRequest,op.controller.signal));
   // A late transferred frame is wiped even after stop/timeout retires us.
   void pending.then(value=>{if(op.closed)wipeTransferred(value);},()=>{});check();
   let reject;const aborted=new Promise((_,no)=>{reject=no;});void aborted.catch(()=>{});const onAbort=()=>reject(failed());op.controller.signal.addEventListener('abort',onAbort,{once:true});
   let value;try{value=await Promise.race([pending,aborted]);transferred=value;}finally{op.controller.signal.removeEventListener('abort',onAbort);}check();
   if(!closed(value,['bytes','capturedMonotonicMs'])||!(value.bytes instanceof Uint8Array)||value.bytes.byteLength<4||value.bytes.byteLength>2097152||!Number.isFinite(value.capturedMonotonicMs)||value.capturedMonotonicMs<received||value.capturedMonotonicMs>op.last)throw failed();
   op.bytes=Uint8Array.from(value.bytes);wipeTransferred(value);check();
   const result=await owner.submit(op.context,{channelId,sequence:1,capturedMonotonicMs:value.capturedMonotonicMs},op.bytes);
   // submitFrame consumes/closes the original channel: final owner/context check
   // uses its independent original host fence, not a now-consumed channel.
   if(this.#closed||op.closed||this.#active.get(channelId)!==op||readNativeUbuntuFrameOwner(this.#host)!==owner||owner.final(op.context,snapshot)!==true||this.#closed||op.closed||this.#active.get(channelId)!==op)throw failed();
   if(!closed(result,['version','state','configurationRevision'])||result.version!==1||!states.has(result.state)||result.configurationRevision!==snapshot.configurationRevision)throw failed();
   return Object.freeze({version:1,state:result.state,configurationRevision:result.configurationRevision});
  }finally{wipeTransferred(transferred);clearTimeout(timer);finish();try{owner.release(op.context,channelId,snapshot);}catch{}}
 }
 stopSession(sessionId){for(const op of this.#active.values())if(op.context.sessionId===sessionId){op.closed=true;op.controller.abort();op.bytes?.fill(0);this.#active.delete(op.channelId);try{op.owner.release(op.context,op.channelId,op.snapshot);}catch{}}}
 cancel(context,channelId){const op=this.#active.get(channelId);if(!op||!same(op.context,context))return;op.closed=true;op.controller.abort();op.bytes?.fill(0);if(this.#active.get(channelId)===op)this.#active.delete(channelId);try{op.owner.release(op.context,channelId,op.snapshot);}catch{}}
 close(){if(this.#closed)return;this.#closed=true;for(const op of [...this.#active.values()])this.stopSession(op.context.sessionId);}
}
