import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {captureGameSanityTiming,type GameSanityTimingInput} from './game-sanity-timing.ts';
import {nativeExecutionLifetimeCurrent,nativeExecutionSessionScoped,nativeExecutionLifetimeSignal,nativeExecutionCustodyBounds,type NativeExecutionLifetime} from './native-execution-lifetime.ts';
import {createServer} from 'node:net';
import {startNativeListener} from './native-listener-start.ts';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameTransportOptions,AuthenticatedGameTransport} from './transport.js';
import {createAuthenticatedGameTransport} from './transport.ts';
import {GameFrameCustody} from './frame-custody.ts';
import {captureWakePreludeConfiguration,type WakePreludeConfiguration} from './ct-wake-prelude.ts';

export const DEFAULT_BIZHAWK_NATIVE_PORT=43183;
export type NativeFrameDecodeInput={request:G.GameObserveRequest;observation:G.GameObservation;bytes:Buffer};
export type NativeFrameDecoder={configurationRef:string|(()=>string);decode:(input:NativeFrameDecodeInput)=>G.PlayerVisibleStateValue[];capture?:(request:G.GameObserveRequest,observation:G.GameObservation)=>NativeFrameDecoder};
export interface NativeGameHostOptions extends Omit<GameTransportOptions,'enrichObservation'>{
 sanityTiming?:GameSanityTimingInput;
 port:number;connectionTimeoutMs:number;frameCustody:GameFrameCustody;
 bounds:G.GameBounds;romSha1:string;
 /** Set only from reviewed fixed native launch facts by the owned factory. */
 wakePrelude?:WakePreludeConfiguration;
 /** Independently reviewed local PNG decoder; never model-supplied field values. */
 frameDecoder?:NativeFrameDecoder;
}
/** Attribution follows the actual independently reviewed decoder at EACH frame. */
export function nativeFrameConfigurationRef(decoder:NonNullable<NativeGameHostOptions['frameDecoder']>):string{
 const value=typeof decoder.configurationRef==='function'?decoder.configurationRef():decoder.configurationRef;
 if(typeof value!=='string'||!value||value.length>500)throw Error('Native decoder reference unavailable');return value;
}
/** Explicitly started, one-peer, loopback-only listener. The supplied qualified
 * source/admission/durable claim callbacks remain mandatory; no live grant,
 * credential, emulator process, backend or reconnect is created here. */
export async function listenForNativeBizHawk(options:NativeGameHostOptions):Promise<{port:number;connected:Promise<AuthenticatedGameTransport>;close:()=>Promise<void>}>{
 const timing=captureGameSanityTiming(options.sanityTiming);
 if(Object.hasOwn(options,'executionLifetime')&&!nativeExecutionLifetimeCurrent(options.executionLifetime!))throw Error('Original native host lifetime unavailable');
 const originalSignal=options.executionLifetime?nativeExecutionLifetimeSignal(options.executionLifetime):undefined,remaining=options.executionLifetime?nativeExecutionCustodyBounds(options.executionLifetime).remainingMs:null;
 if(!Number.isSafeInteger(options.port)||options.port<1024||options.port>65535||!Number.isSafeInteger(options.connectionTimeoutMs)||options.connectionTimeoutMs<1||options.connectionTimeoutMs>timing.nativeStartupTimeoutMs||options.pairingSecret.byteLength<32||options.pairingSecret.byteLength>128||!options.boundary.acceptObservation||!/^[a-f0-9]{40}$/.test(options.romSha1)||!createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameBounds',options.bounds).valid)throw Error('Native game host configuration unavailable');
 const limits=options.frameCustody.limits;if(limits.maxBytes>options.bounds.maxScreenshotBytes||limits.maxQueueBytes>options.bounds.screenshotQueueByteBudget||limits.maxLongEdge>options.bounds.maxScreenshotLongEdge)throw Error('Native custody exceeds game bounds');
 if(!Number.isSafeInteger(options.authenticationTimeoutMs)||options.authenticationTimeoutMs<1||options.authenticationTimeoutMs>10000||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<options.authenticationTimeoutMs||options.sessionDurationMs>(options.executionLifetime&&nativeExecutionSessionScoped(options.executionLifetime)?ORDINARY_GAME_SESSION_LIMITS.maximumMs:600000))throw Error('Native authentication bounds unavailable');
 if(options.frameDecoder&&(typeof options.frameDecoder.decode!=='function'||!nativeFrameConfigurationRef(options.frameDecoder)))throw Error('Native decoder unavailable');
 const decoded=new Map<string,G.GameObservation>();
 const enrichObservation=options.frameDecoder?((request:G.GameObserveRequest,observation:G.GameObservation)=>{
  if(!options.boundary.sourceAvailable(request.scope,observation.pinsDigest)||decoded.size>=limits.maxFrames||!options.frameCustody.ingest(observation))throw Error('Native decoded frame unavailable');
  const frame=options.frameCustody.read(observation.screenshots[0]!.mediaRef,request.scope);
  try{const decoder=options.frameDecoder!.capture?.(request,observation)??options.frameDecoder!;const fields=decoder.decode({request,observation:structuredClone(observation),bytes:frame.bytes});const enriched={...observation,visibleState:structuredClone(fields),interpretedAt:new Date().toISOString(),providerConfigurationRef:nativeFrameConfigurationRef(decoder)};if(!options.boundary.sourceAvailable(request.scope,observation.pinsDigest))throw Error('Native decoder source changed');decoded.set(enriched.observationId,structuredClone(enriched));return enriched;}finally{frame.bytes.fill(0);}
 }):undefined;
 const acceptObservation=(request:G.GameObserveRequest,observation:G.GameObservation)=>{
  if(enrichObservation){const expected=decoded.get(observation.observationId);decoded.delete(observation.observationId);if(!expected||!isDeepStrictEqual(expected,observation))return false;}else if(!options.frameCustody.ingest(observation))return false;
  return options.boundary.acceptObservation!(request,observation);
 };
 const setupStop=new AbortController();
 const secret=Buffer.from(options.pairingSecret);let transport:AuthenticatedGameTransport|undefined,timer:ReturnType<typeof setTimeout>,closed=false,settled=false;
 let accept!:(value:AuthenticatedGameTransport)=>void,reject!:(error:Error)=>void;
 const connected=new Promise<AuthenticatedGameTransport>((resolve,fail)=>{accept=resolve;reject=fail;});void connected.catch(()=>{});
 const server=createServer(socket=>{
  if(closed||settled||socket.remoteAddress!=='127.0.0.1'){socket.destroy();return;}settled=true;clearTimeout(timer);server.close();
  try{transport=createAuthenticatedGameTransport(socket,{...options,pairingSecret:secret,...(enrichObservation?{enrichObservation}:{}),boundary:{...options.boundary,acceptObservation},onDisconnect:code=>{decoded.clear();options.frameCustody.dispose();options.onDisconnect(code);}});secret.fill(0);accept(transport);}catch{secret.fill(0);socket.destroy();reject(Error('Native game authentication unavailable'));}
 });
 const shutdown=async()=>{if(closed)return;closed=true;setupStop.abort();clearTimeout(timer);originalSignal?.removeEventListener('abort',originalAbort);secret.fill(0);transport?.close();decoded.clear();options.frameCustody.dispose();if(!settled){settled=true;reject(Error('Native game host closed'));}await new Promise<void>(resolve=>{if(server.listening)server.close(()=>resolve());else resolve();});};
 server.on('error',()=>{if(!settled){settled=true;reject(Error('Native game listener unavailable'));}void shutdown();});
 const originalAbort=()=>{if(!settled)void shutdown();};originalSignal?.addEventListener('abort',originalAbort,{once:true});
 timer=setTimeout(()=>{void shutdown();},remaining===null?options.connectionTimeoutMs:Math.min(options.connectionTimeoutMs,remaining));
 try{await startNativeListener(server,options.port,setupStop.signal);if(originalSignal?.aborted){await shutdown();throw Error('Original native owner cancelled');}}catch{await shutdown();throw Error('Native game listener unavailable');}
 return {port:options.port,connected,close:shutdown};
}
/** Process-scoped child environment; caller must already supply an approved
 * pairing secret and exact scoped configuration. Never generates credentials. */
export function nativeBridgeEnvironment(options:NativeGameHostOptions):Record<string,string>{
 const secret=Buffer.from(options.pairingSecret);
 if(Object.hasOwn(options,'executionLifetime')&&!nativeExecutionLifetimeCurrent(options.executionLifetime!)){secret.fill(0);throw Error('Original native bridge lifetime unavailable');}
 try{const nativeAuthority=options.executionLifetime?nativeExecutionCustodyBounds(options.executionLifetime):undefined;return {LIFESTREAM_BIZHAWK_PAIRING_SECRET:secret.toString('base64'),LIFESTREAM_BIZHAWK_OPTIONS:JSON.stringify({protocol:'lifestream-game-control/1',port:options.port,providerRef:options.boundary.providerRef,pinsDigest:options.pinsDigest,scope:options.scope,scopeDigest:createHash('sha256').update(JSON.stringify(options.scope)).digest('hex'),frameDirectory:options.frameCustody.directory,sessionDurationMs:options.sessionDurationMs,...(nativeAuthority?{nativeAuthority}:{}),authenticationTimeoutMs:options.authenticationTimeoutMs,emulatorVersion:'2.11.1',romSha1:options.romSha1,...(options.wakePrelude===undefined?{}:{wakePrelude:captureWakePreludeConfiguration(options.wakePrelude)}),bounds:options.bounds,frameTtlMs:options.frameCustody.limits.maxTtlMs,maximumCustodyFrames:options.frameCustody.limits.maxFrames})};}finally{secret.fill(0);}
}
