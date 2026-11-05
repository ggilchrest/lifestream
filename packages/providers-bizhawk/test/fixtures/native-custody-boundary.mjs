import {createNativeOwnerFailureWitness} from '../../src/native-owner-failure-witness.ts';
import {captureGameSanityTiming} from '../../src/game-sanity-timing.ts';
import {createNativeInspectionTiming} from '../../src/native-refresh-timing.ts';
import {types} from 'node:util';
import {captureNativeSource,nativeSourceAge,nativeSourceException} from '../../src/native-source-witness.ts';
// Exact selected original custody+inspection closures with deterministic ports.
// No engine, native process, original files, credentials, DB or game authority.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
export function nativeCustodyFixture(sanityTiming={inspectionFreshnessMs:2000,receiptFreshnessMs:3000,noProgressTimeoutMs:3000},suppliedScope){
 const source=readFileSync(process.env.CT79_NATIVE_OWNER_FILE??new URL('../../src/owned-c72-native.ts',import.meta.url),'utf8');
 const a=source.search(/let custodyDiagnosticArmed\s*=/),b=a+source.slice(a).search(/const evidence\s*=/),c=source.search(/const inspectionOwnerCurrent\s*=/),d=c+source.slice(c).search(/const acceptWakeProof\s*=/);assert(a>=0&&b>a&&c>b&&d>c);const selected=stripTypeScriptTypes(source.slice(a,b)+source.slice(c,d),{mode:'strip'});
 let wall=Date.now(),mono=1000,available=true,calls=0,wait=null,release;const control=new AbortController(),scope=suppliedScope??{runId:'00000000-0000-4000-8000-000000000001'},pins='a'.repeat(64),id='b'.repeat(64),nonce='c'.repeat(32),IMAGE='d'.repeat(64),sourcePins={},imagePins={},events=[];
 const facts={runDirectory:'/synthetic-private-run',expiresAt:new Date(wall+120000).toISOString(),imagePins};
 const ownerFailures=[],witnesses=new WeakMap(),ownerError=(stage,predicate,message)=>{const error=Error(message),witness=createNativeOwnerFailureWitness(stage,predicate,error);if(witness)witnesses.set(error,witness);return error;};
 const deps={ownerError,types,createNativeOwnerFailureWitness,reportNativeOpenFailure:(_stage,error,fallback)=>ownerFailures.push(witnesses.get(error)??fallback),timing:captureGameSanityTiming(sanityTiming),captureNativeSource,nativeSourceAge,nativeSourceException,Date:{now:()=>wall,parse:Date.parse},performance:{now:()=>mono},options:{onFailure:v=>events.push(v)},readNativeFile:()=>Buffer.from(JSON.stringify({schemaVersion:'ct-native-custody/1',invocation:nonce,image:IMAGE,scopeDigest:'e'.repeat(64),pinsDigest:pins,sourcePins,imagePins,viewable:true,startupPaused:true,pid:15,startTicks:1,sequence:Math.floor(mono/1000)+1,checkedAtMs:wall,configSha256:'f'.repeat(64)})),join,isDeepStrictEqual,scopeDigest:()=> 'e'.repeat(64),fileDigest:()=>{throw Error('No wake archive in inert custody fixture');},facts,scope,pins,nonce,C72_IMAGE:IMAGE,sourcePins,evidence:{installationAvailable:()=>available},inspect:async(selected,running)=>{calls++;assert.equal(selected,id);assert.equal(running,true);if(wait)await wait;}};
 deps.readNativePublishedFile=deps.readNativeFile;
 deps.inspectionTiming=createNativeInspectionTiming();
 const state='let closed=false,lastWall=Date.now(),clockCurrent=true,expiresMono=121000,child={pid:10,exitCode:null,signalCode:null},cid=id,verifiedRunning=true,inspectChecked=Date.now(),lastSequence=0,lastReceiptWall=0,lastReceiptMono=0,startTicks,monoPid,configurationHash,wakeProof=null,inspectionOperation,nativeSignal=control.signal;';
 const f=compileFunction(state+selected+'\ncustodyDiagnosticArmed=true;return {check:custodyCurrent,refresh:refreshCustody,startInspection:refreshInspection,inspection:()=>inspectChecked,close:()=>{closed=true;}};',[...Object.keys(deps),'control','id'])(...Object.values(deps),control,id);
 return {...f,ownerFailures,witnessFor:error=>witnesses.get(error),scope,pins,events,signal:control.signal,abort:()=>control.abort(),withdraw:()=>{available=false;},advance:ms=>{wall+=ms;mono+=ms;},now:()=>wall,calls:()=>calls,hold:()=>{wait=new Promise(resolve=>release=resolve);},release:()=>{wait=null;release?.();}};
}
