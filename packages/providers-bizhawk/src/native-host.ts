import {createServer} from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameTransportOptions,AuthenticatedGameTransport} from './transport.js';
import {createAuthenticatedGameTransport} from './transport.ts';
import {GameFrameCustody} from './frame-custody.ts';

export const DEFAULT_BIZHAWK_NATIVE_PORT=43183;
export interface NativeGameHostOptions extends Omit<GameTransportOptions,'enrichObservation'>{
 port:number;connectionTimeoutMs:number;frameCustody:GameFrameCustody;
 bounds:G.GameBounds;romSha1:string;
 /** Independently reviewed local PNG decoder; never model-supplied field values. */
 frameDecoder?:{configurationRef:string;decode:(input:{request:G.GameObserveRequest;observation:G.GameObservation;bytes:Buffer})=>G.PlayerVisibleStateValue[]};
}
/** Explicitly started, one-peer, loopback-only listener. The supplied qualified
 * source/admission/durable claim callbacks remain mandatory; no live grant,
 * credential, emulator process, backend or reconnect is created here. */
export async function listenForNativeBizHawk(options:NativeGameHostOptions):Promise<{port:number;connected:Promise<AuthenticatedGameTransport>;close:()=>Promise<void>}>{
 if(!Number.isSafeInteger(options.port)||options.port<1024||options.port>65535||!Number.isSafeInteger(options.connectionTimeoutMs)||options.connectionTimeoutMs<1||options.connectionTimeoutMs>10000||options.pairingSecret.byteLength<32||options.pairingSecret.byteLength>128||!options.boundary.acceptObservation||!/^[a-f0-9]{40}$/.test(options.romSha1)||!createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameBounds',options.bounds).valid)throw Error('Native game host configuration unavailable');
 const limits=options.frameCustody.limits;if(limits.maxBytes>options.bounds.maxScreenshotBytes||limits.maxQueueBytes>options.bounds.screenshotQueueByteBudget||limits.maxLongEdge>options.bounds.maxScreenshotLongEdge)throw Error('Native custody exceeds game bounds');
 if(!Number.isSafeInteger(options.authenticationTimeoutMs)||options.authenticationTimeoutMs<1||options.authenticationTimeoutMs>10000||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<options.authenticationTimeoutMs||options.sessionDurationMs>600000)throw Error('Native authentication bounds unavailable');
 if(options.frameDecoder&&(typeof options.frameDecoder.decode!=='function'||typeof options.frameDecoder.configurationRef!=='string'||!options.frameDecoder.configurationRef||options.frameDecoder.configurationRef.length>500))throw Error('Native decoder unavailable');
 const decoded=new Map<string,G.GameObservation>();
 const enrichObservation=options.frameDecoder?((request:G.GameObserveRequest,observation:G.GameObservation)=>{
  if(!options.boundary.sourceAvailable(request.scope,observation.pinsDigest)||decoded.size>=limits.maxFrames||!options.frameCustody.ingest(observation))throw Error('Native decoded frame unavailable');
  const frame=options.frameCustody.read(observation.screenshots[0]!.mediaRef,request.scope);
  try{const fields=options.frameDecoder!.decode({request,observation:structuredClone(observation),bytes:frame.bytes});const enriched={...observation,visibleState:structuredClone(fields),interpretedAt:new Date().toISOString(),providerConfigurationRef:options.frameDecoder!.configurationRef};if(!options.boundary.sourceAvailable(request.scope,observation.pinsDigest))throw Error('Native decoder source changed');decoded.set(enriched.observationId,structuredClone(enriched));return enriched;}finally{frame.bytes.fill(0);}
 }):undefined;
 const acceptObservation=(request:G.GameObserveRequest,observation:G.GameObservation)=>{
  if(enrichObservation){const expected=decoded.get(observation.observationId);decoded.delete(observation.observationId);if(!expected||!isDeepStrictEqual(expected,observation))return false;}else if(!options.frameCustody.ingest(observation))return false;
  return options.boundary.acceptObservation!(request,observation);
 };
 const secret=Buffer.from(options.pairingSecret);let transport:AuthenticatedGameTransport|undefined,timer:ReturnType<typeof setTimeout>,closed=false,settled=false;
 let accept!:(value:AuthenticatedGameTransport)=>void,reject!:(error:Error)=>void;
 const connected=new Promise<AuthenticatedGameTransport>((resolve,fail)=>{accept=resolve;reject=fail;});void connected.catch(()=>{});
 const server=createServer(socket=>{
  if(closed||settled||socket.remoteAddress!=='127.0.0.1'){socket.destroy();return;}settled=true;clearTimeout(timer);server.close();
  try{transport=createAuthenticatedGameTransport(socket,{...options,pairingSecret:secret,...(enrichObservation?{enrichObservation}:{}),boundary:{...options.boundary,acceptObservation},onDisconnect:code=>{decoded.clear();options.frameCustody.dispose();options.onDisconnect(code);}});secret.fill(0);accept(transport);}catch{secret.fill(0);socket.destroy();reject(Error('Native game authentication unavailable'));}
 });
 const shutdown=async()=>{if(closed)return;closed=true;clearTimeout(timer);secret.fill(0);transport?.close();decoded.clear();options.frameCustody.dispose();if(!settled){settled=true;reject(Error('Native game host closed'));}await new Promise<void>(resolve=>{if(server.listening)server.close(()=>resolve());else resolve();});};
 server.on('error',()=>{if(!settled){settled=true;reject(Error('Native game listener unavailable'));}void shutdown();});
 timer=setTimeout(()=>{void shutdown();},options.connectionTimeoutMs);
 try{server.listen({host:'127.0.0.1',port:options.port,exclusive:true});await once(server,'listening');}catch{await shutdown();throw Error('Native game listener unavailable');}
 return {port:options.port,connected,close:shutdown};
}
/** Process-scoped child environment; caller must already supply an approved
 * pairing secret and exact scoped configuration. Never generates credentials. */
export function nativeBridgeEnvironment(options:NativeGameHostOptions):Record<string,string>{
 return {LIFESTREAM_BIZHAWK_PAIRING_SECRET:Buffer.from(options.pairingSecret).toString('base64'),LIFESTREAM_BIZHAWK_OPTIONS:JSON.stringify({protocol:'lifestream-game-control/1',port:options.port,providerRef:options.boundary.providerRef,pinsDigest:options.pinsDigest,scope:options.scope,scopeDigest:createHash('sha256').update(JSON.stringify(options.scope)).digest('hex'),frameDirectory:options.frameCustody.directory,sessionDurationMs:options.sessionDurationMs,authenticationTimeoutMs:options.authenticationTimeoutMs,emulatorVersion:'2.11.1',romSha1:options.romSha1,bounds:options.bounds,frameTtlMs:options.frameCustody.limits.maxTtlMs,maximumCustodyFrames:options.frameCustody.limits.maxFrames})};
}
