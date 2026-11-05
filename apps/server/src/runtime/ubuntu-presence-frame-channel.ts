import {createHash,randomBytes} from 'node:crypto';
import type {LocalAuthentication,LocalContext} from '../auth/local-auth.ts';
import type {UbuntuOperationCapture,UbuntuPresenceFrame,UbuntuPresenceGrant} from './ubuntu-presence-composition.ts';
import {referenceVisualBounds} from '@lifestream/runtime/perception/port';

const canonical=(v:unknown):string=>v&&typeof v==='object'&&!Array.isArray(v)?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const frameKey=(frame:UbuntuPresenceFrame)=>hash({...frame,bytes:createHash('sha256').update(frame.bytes).digest('hex')});
const token=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===keys.sort().join('|');
export type PresenceChannelOffer={channelId:string;purpose:'identityEnrollment'|'persistentPresence';expiresAt:number;remainingMs:number;challenge:{id:string;hostSentMonotonicMs:number;maxClockUncertaintyMs:250}};
export type PresenceClockReply={channelId:string;challengeId:string;endpointClockId:string;endpointReceivedMonotonicMs:number};
export type PresenceFrameMetadata={channelId:string;sequence:number;capturedMonotonicMs:number};
type Mapping={endpointClockId:string;endpointReceivedMono:number;hostSentMono:number;hostReceivedMono:number;anchorUtc:number};
type Entry={id:string;handle:object;capture:UbuntuOperationCapture;startedUtc:number;startedMono:number;challengeId:string;sentUtc:number;sentMono:number;mapping?:Mapping;consumed:boolean;frame?:UbuntuPresenceFrame;frameKey?:string;closed:boolean};
export type PresenceChannelPorts={authentication:Pick<LocalAuthentication,'assertCurrent'|'hostSessionContext'>;capture:(handle:object)=>UbuntuOperationCapture|null;release:(handle:object)=>void;frameCurrent:(frame:UbuntuPresenceFrame,grant:UbuntuPresenceGrant)=>boolean;now?:()=>number;monotonicMs?:()=>number};

/** Host-owned transient admission, not physical camera or browser code attestation.
 * A captured original grant precedes the offer. Client metadata cannot supply
 * actor, endpoint, resource, purpose, source, lease, model or consent authority.
 * No timer, decoder, provider, key, durable frame or automatic capture is created.
 */
export class UbuntuPresenceFrameChannel{
 private readonly ports:PresenceChannelPorts;private readonly entries=new Map<string,Entry>();private readonly frames=new WeakMap<object,Entry>();private closed=false;
 private lastUtc=-Infinity;private lastMono=-Infinity;
 constructor(ports:PresenceChannelPorts){this.ports=ports;}
 private clocks(){const utc=(this.ports.now??Date.now)(),mono=(this.ports.monotonicMs??(()=>performance.now()))();if(![utc,mono].every(Number.isFinite)||utc<this.lastUtc||mono<this.lastMono)throw Error('PRESENCE_CLOCK_UNAVAILABLE');this.lastUtc=utc;this.lastMono=mono;return {utc,mono};}
 private context(c:LocalContext):boolean{try{this.ports.authentication.assertCurrent(c,false);return hash(this.ports.authentication.hostSessionContext(c.sessionId))===hash(c);}catch{return false;}}
 private live(e:Entry):boolean{try{const end=this.clocks();return !this.closed&&!e.closed&&this.entries.get(e.id)===e&&end.utc>=e.startedUtc&&end.mono>=e.startedMono&&end.utc<Math.min(e.capture.grant.authorityExpiresAt,e.capture.grant.expiresAt)&&end.mono<e.capture.untilMonotonicMs&&this.context(e.capture.context)&&!this.closed&&!e.closed&&this.entries.get(e.id)===e;}catch{return false;}}
 private original(e:Entry):boolean{try{const actual=this.ports.capture(e.handle);return !!actual&&hash(actual)===hash(e.capture)&&this.live(e);}catch{return false;}}
 open(context:LocalContext,handle:object):PresenceChannelOffer|null{
  let entry:Entry|undefined;try{if(this.closed||this.entries.size>=4||!this.context(context))return null;
   const start=this.clocks(),raw=this.ports.capture(handle);if(!raw||hash(raw.context)!==hash(context))return null;const capture=structuredClone(raw),g=capture.grant;
   if(!Number.isFinite(g.authorityExpiresAt)||g.authorityExpiresAt<=start.utc||g.authorityExpiresAt>start.utc+5000||capture.untilMonotonicMs<=start.mono||capture.untilMonotonicMs>start.mono+5000||g.sessionId!==context.sessionId||g.actorId!==context.principalId||g.captureLeaseId!==capture.lease.leaseId||g.captureFence!==capture.lease.fencingToken||capture.lease.status!=='active'||capture.lease.resourceId!==g.resourceId)return null;
   const sent=this.clocks(),id=randomBytes(32).toString('hex');entry={id,handle,capture,startedUtc:start.utc,startedMono:start.mono,challengeId:randomBytes(32).toString('hex'),sentUtc:sent.utc,sentMono:sent.mono,consumed:false,closed:false};this.entries.set(id,entry);
   if(!this.original(entry)){this.close(id);return null;}return {channelId:id,purpose:g.purpose,expiresAt:g.authorityExpiresAt,remainingMs:Math.min(g.authorityExpiresAt-entry.sentUtc,g.expiresAt-entry.sentUtc,capture.untilMonotonicMs-entry.sentMono),challenge:{id:entry.challengeId,hostSentMonotonicMs:entry.sentMono,maxClockUncertaintyMs:250}};
  }catch{if(entry)this.close(entry.id);return null;}
 }
 bind(context:LocalContext,reply:PresenceClockReply):boolean{
  if(!closed(reply,['channelId','challengeId','endpointClockId','endpointReceivedMonotonicMs'])||!token(reply.channelId)||!token(reply.challengeId)||!token(reply.endpointClockId)||!Number.isFinite(reply.endpointReceivedMonotonicMs)||reply.endpointReceivedMonotonicMs<0)return false;
  const e=this.entries.get(reply.channelId);if(!e||e.consumed||e.mapping||reply.challengeId!==e.challengeId||hash(context)!==hash(e.capture.context))return false;
  try{const received=this.clocks();if(received.mono-e.sentMono>referenceVisualBounds.maxClockUncertaintyMs||!this.original(e))return false;
   const mapping={endpointClockId:reply.endpointClockId,endpointReceivedMono:reply.endpointReceivedMonotonicMs,hostSentMono:e.sentMono,hostReceivedMono:received.mono,anchorUtc:e.sentUtc};
   if(!this.context(context)||!this.live(e)||e.mapping||e.consumed)return false;e.mapping=mapping;return true;
  }catch{return false;}
 }
 accept(context:LocalContext,metadata:PresenceFrameMetadata,bytes:Uint8Array):UbuntuPresenceFrame|null{
  if(!closed(metadata,['channelId','sequence','capturedMonotonicMs'])||!token(metadata.channelId)||metadata.sequence!==1||!Number.isFinite(metadata.capturedMonotonicMs)||!(bytes instanceof Uint8Array)||bytes.byteLength<4||bytes.byteLength>2*1024*1024)return null;
  const e=this.entries.get(metadata.channelId),m=e?.mapping;if(!e||!m||e.consumed||hash(context)!==hash(e.capture.context))return null;let held:Uint8Array|undefined;
  try{const received=this.clocks();if(metadata.capturedMonotonicMs<m.endpointReceivedMono||!this.original(e))return null;
   // Same conservative drift/round-trip interval as original visual admission.
   const elapsed=Math.abs(metadata.capturedMonotonicMs-m.endpointReceivedMono),low=metadata.capturedMonotonicMs+m.hostSentMono-m.endpointReceivedMono-elapsed*.0001,high=metadata.capturedMonotonicMs+m.hostReceivedMono-m.endpointReceivedMono+elapsed*.0001;
   if(high-low>referenceVisualBounds.maxClockUncertaintyMs||high>received.mono||received.mono-low>=5000)return null;
   held=Uint8Array.from(bytes);const frame:UbuntuPresenceFrame={bytes:held,observedAt:Math.floor(m.anchorUtc+low-m.hostSentMono),receivedAt:received.utc,captureLeaseId:e.capture.grant.captureLeaseId,captureFence:e.capture.grant.captureFence,sourceId:e.capture.binding.cameraSourceId,configurationRevision:e.capture.binding.configurationRevision};
   // Reserve before calling a trusted port, so reentrant accept cannot consume
   // or substitute a second sample. No callback is repeated to invent authority.
   e.consumed=true;e.frame=frame;e.frameKey=frameKey(frame);this.frames.set(frame,e);
   if(this.ports.frameCurrent(frame,structuredClone(e.capture.grant))!==true||!this.context(context)||!this.original(e)||e.frame!==frame||e.frameKey!==frameKey(frame)){held.fill(0);this.close(e.id);return null;}
   return frame;
  }catch{held?.fill(0);this.close(e.id);return null;}
 }
 owns(frame:UbuntuPresenceFrame):boolean{return this.frames.has(frame);}
 current(frame:UbuntuPresenceFrame,grant:UbuntuPresenceGrant):boolean{
  const e=this.frames.get(frame);return !!e&&e.frame===frame&&e.consumed&&e.frameKey===frameKey(frame)&&hash(grant)===hash(e.capture.grant)&&this.live(e);
 }
 handle(context:LocalContext,id:string):object|null{const e=this.entries.get(id);return e&&hash(context)===hash(e.capture.context)&&this.live(e)?e.handle:null;}
 /** Explicit request-time retirement only. A consumed frame retains its exact
  * custody through the original verdict/cleanup, even after authority expires. */
 retireExpired():void{let end:{utc:number;mono:number};try{end=this.clocks();}catch{return;}for(const e of [...this.entries.values()])if(!e.consumed&&!e.closed&&this.entries.get(e.id)===e&&end.utc>=e.startedUtc&&end.mono>=e.startedMono&&(end.utc>=Math.min(e.capture.grant.authorityExpiresAt,e.capture.grant.expiresAt)||end.mono>=e.capture.untilMonotonicMs))this.close(e.id);}
 has(id:string):boolean{return this.entries.has(id);}
 close(id:string):void{const e=this.entries.get(id);if(!e)return;e.closed=true;this.entries.delete(id);e.frame?.bytes.fill(0);try{this.ports.release(e.handle);}catch{} }
 stopSession(sessionId:string):void{for(const e of [...this.entries.values()])if(e.capture.context.sessionId===sessionId)this.close(e.id);}
 closeAll():void{for(const id of [...this.entries.keys()])this.close(id);}
 dispose():void{this.closed=true;this.closeAll();}
}
