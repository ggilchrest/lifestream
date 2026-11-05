import {isDeepStrictEqual} from 'node:util';

export const CT_WAKE_PREPARATION='ct50-prefix33/1';
export const CT_WAKE_INITIAL_FRAME=84173;
export const CT_WAKE_HANDOFF_FRAME=84569;
export const CT_WAKE_MAX_MS=8000;
export const CT_WAKE_INITIAL_PNG='7afa5a32b5724f233a145324108b4e6a0c482a40627e4993ba6c087ad672d520';
export const CT_WAKE_HANDOFF_PNG='03de85e30f25c5cf7e198b4a1df54c8cf9f3d4d822c5209f3c9fe787f536818d';
const keys=(v:unknown,names:string[]):boolean=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
const integer=(v:unknown):v is number=>Number.isSafeInteger(v);
const refuse=():never=>{throw Error('Reviewed fixed native wake preparation unavailable');};
export type WakePreludeConfiguration=Readonly<{kind:typeof CT_WAKE_PREPARATION;invocationNonce:string}>;
/** Trusted launch facts only; no vectors, paths, durations or executable code. */
export function captureWakePreparation(v:unknown):typeof CT_WAKE_PREPARATION|undefined{
 if(v===undefined)return undefined;
 if(v!==CT_WAKE_PREPARATION)refuse();return CT_WAKE_PREPARATION;
}
export function captureWakePreludeConfiguration(v:any):WakePreludeConfiguration{
 if(!keys(v,['kind','invocationNonce'])||v.kind!==CT_WAKE_PREPARATION||typeof v.invocationNonce!=='string'||!/^[a-f0-9]{32}$/.test(v.invocationNonce))refuse();
 return Object.freeze({kind:CT_WAKE_PREPARATION,invocationNonce:v.invocationNonce});
}
const recipe=['A','','A',...Array(30).fill('')];
const shotKeys=['screenshotId','mediaRef','sha256','byteLength','mediaType','width','height','capturedAt','frameNumber','expiresAt'];
function shot(v:any,frame:number,hash:string,now:number,maximumScreenshotTtlMs:number){
 if(!keys(v,shotKeys)||typeof v.screenshotId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.screenshotId)||v.mediaRef!==v.screenshotId||v.sha256!==hash||!integer(v.byteLength)||v.byteLength<57||v.byteLength>2097152||v.mediaType!=='image/png'||v.width!==256||v.height!==224||v.frameNumber!==frame||!Number.isFinite(Date.parse(v.capturedAt))||Date.parse(v.capturedAt)>now||!Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)<=now||Date.parse(v.expiresAt)-Date.parse(v.capturedAt)>maximumScreenshotTtlMs)refuse();
}
/** Pure receipt check. The owned factory independently reads/hash-checks the
 * two actual files, process custody and immutable receipt bytes before use. */
export function validateWakePreludeReceipt(v:any,e:{scope:any;scopeDigest:string;pinsDigest:string;invocationNonce:string;pid:number;startTicks:number;nowMs:number;maximumScreenshotTtlMs?:number}){
 // Trusted selected frame retention, not receipt-selected authority. Keep the
 // legacy30s default; never change original capture/expiry or custody checks.
 const maximumScreenshotTtlMs=e.maximumScreenshotTtlMs===undefined?30000:e.maximumScreenshotTtlMs;
 if(!integer(maximumScreenshotTtlMs)||maximumScreenshotTtlMs<1||maximumScreenshotTtlMs>300000)refuse();
 const fields=['schemaVersion','kind','status','scope','scopeDigest','pinsDigest','invocationNonce','nativePid','nativeStartTicks','initialFrame','handoffFrame','actionCount','completedActionCount','controlledFrames','frameDelta','startedAt','completedAt','startedMonotonicMs','completedMonotonicMs','elapsedMs','paused','neutral','initialScreenshot','finalScreenshot','actions'];
 if(!keys(v,fields)||v.schemaVersion!=='ct-wake-prelude/1'||v.kind!==CT_WAKE_PREPARATION||v.status!=='complete'||!isDeepStrictEqual(v.scope,e.scope)||v.scopeDigest!==e.scopeDigest||v.pinsDigest!==e.pinsDigest||v.invocationNonce!==e.invocationNonce||!integer(v.nativePid)||v.nativePid<1||!integer(v.nativeStartTicks)||v.nativeStartTicks<1||v.nativePid!==e.pid||v.nativeStartTicks!==e.startTicks||v.initialFrame!==CT_WAKE_INITIAL_FRAME||v.handoffFrame!==CT_WAKE_HANDOFF_FRAME||v.actionCount!==33||v.completedActionCount!==33||v.controlledFrames!==396||v.frameDelta!==396||v.paused!==true||v.neutral!==true||!Array.isArray(v.actions)||v.actions.length!==33)refuse();
 if(!Number.isFinite(v.startedMonotonicMs)||!Number.isFinite(v.completedMonotonicMs)||!Number.isFinite(v.elapsedMs)||v.startedMonotonicMs<0||v.completedMonotonicMs<v.startedMonotonicMs||v.elapsedMs<0||Math.abs(v.elapsedMs-(v.completedMonotonicMs-v.startedMonotonicMs))>0.01||v.elapsedMs>CT_WAKE_MAX_MS||!Number.isFinite(e.nowMs)||!Number.isFinite(Date.parse(v.startedAt))||!Number.isFinite(Date.parse(v.completedAt))||Date.parse(v.startedAt)>Date.parse(v.completedAt)||Date.parse(v.completedAt)>e.nowMs||e.nowMs-Date.parse(v.completedAt)>10000)refuse();
 for(let i=0;i<33;i++){
  const a=v.actions[i];if(!keys(a,['index','button','beforeFrame','afterFrame','framesApplied','startedMonotonicMs','completedMonotonicMs','wallMs','paused','neutral'])||a.index!==i+1||a.button!==recipe[i]||a.beforeFrame!==CT_WAKE_INITIAL_FRAME+i*12||a.afterFrame!==CT_WAKE_INITIAL_FRAME+(i+1)*12||a.framesApplied!==12||a.paused!==true||a.neutral!==true||!Number.isFinite(a.startedMonotonicMs)||!Number.isFinite(a.completedMonotonicMs)||!Number.isFinite(a.wallMs)||a.startedMonotonicMs<v.startedMonotonicMs||a.completedMonotonicMs<a.startedMonotonicMs||a.completedMonotonicMs>v.completedMonotonicMs||a.wallMs<0||Math.abs(a.wallMs-(a.completedMonotonicMs-a.startedMonotonicMs))>0.01||a.wallMs>500||i>0&&a.startedMonotonicMs<v.actions[i-1].completedMonotonicMs)refuse();
 }
 shot(v.initialScreenshot,CT_WAKE_INITIAL_FRAME,CT_WAKE_INITIAL_PNG,e.nowMs,maximumScreenshotTtlMs);shot(v.finalScreenshot,CT_WAKE_HANDOFF_FRAME,CT_WAKE_HANDOFF_PNG,e.nowMs,maximumScreenshotTtlMs);
 if(v.initialScreenshot.mediaRef===v.finalScreenshot.mediaRef||Date.parse(v.initialScreenshot.capturedAt)<Date.parse(v.startedAt)||Date.parse(v.finalScreenshot.capturedAt)>Date.parse(v.completedAt)||Date.parse(v.initialScreenshot.capturedAt)>Date.parse(v.finalScreenshot.capturedAt))refuse();
 return v;
}
