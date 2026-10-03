import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameInferenceSelectionDigest,type GameInferenceSelection,type GameRuntimeOptions} from './game-host-runtime.ts';

export type GameQualifiedProcess={pid:number;processStartTicks:string;binarySha256:string;modelSha256:string;projectorSha256:string|null;envelopeDigest:string};
export type GameQualificationReceipt={schemaVersion:'1.0.0';recordType:'gameInferenceQualification';qualificationRef:string;selection:GameInferenceSelection;process:GameQualifiedProcess;preemptionBoundMs:number;slotReleaseBoundMs:number;verifiedAt:string;expiresAt:string};
export type GameQualificationBindingOptions={receipt:GameQualificationReceipt;receiptSha256:string;readReceipt:()=>Uint8Array|null;processCurrent:(process:Readonly<GameQualifiedProcess>,selection:Readonly<GameInferenceSelection>)=>boolean;now?:()=>number};
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(v:unknown,names:string)=>!!v&&typeof v==='object'&&Object.keys(v).sort().join(',')===names;

/** A trusted measured artifact plus actual process generation qualifies the
 * exact server-selected provider. Health or a model's response cannot do so. */
export function createGameInferenceQualificationBinding(options:GameQualificationBindingOptions):NonNullable<GameRuntimeOptions['inferenceQualificationFor']>{
 const receipt=boundedGameDataSnapshot(options.receipt,32768) as GameQualificationReceipt|null;
 const read=options.readReceipt,processCurrent=options.processCurrent,now=options.now??Date.now,expectedSha=options.receiptSha256;
 if(!receipt||!digest(expectedSha)||!keys(receipt,'expiresAt,preemptionBoundMs,process,qualificationRef,recordType,schemaVersion,selection,slotReleaseBoundMs,verifiedAt')||receipt.schemaVersion!=='1.0.0'||receipt.recordType!=='gameInferenceQualification'||typeof receipt.qualificationRef!=='string'||!receipt.qualificationRef.trim()||receipt.qualificationRef.length>1024||!keys(receipt.selection,'configurationDigest,fixture,healthy,model,modelArtifactDigest,providerRef,providerRevision')||!digest(receipt.selection.configurationDigest)||!digest(receipt.selection.modelArtifactDigest)||receipt.selection.fixture!==false||receipt.selection.healthy!==true||![receipt.selection.providerRef,receipt.selection.providerRevision,receipt.selection.model].every(v=>typeof v==='string'&&v.trim().length>0&&v.length<=2048)||!keys(receipt.process,'binarySha256,envelopeDigest,modelSha256,pid,processStartTicks,projectorSha256')||!Number.isSafeInteger(receipt.process.pid)||receipt.process.pid<1||!/^[0-9]+$/.test(receipt.process.processStartTicks)||![receipt.process.binarySha256,receipt.process.modelSha256,receipt.process.envelopeDigest].every(digest)||receipt.process.projectorSha256!==null&&!digest(receipt.process.projectorSha256)||receipt.process.modelSha256!==receipt.selection.modelArtifactDigest||!Number.isFinite(receipt.preemptionBoundMs)||receipt.preemptionBoundMs<=0||receipt.preemptionBoundMs>10||!Number.isFinite(receipt.slotReleaseBoundMs)||receipt.slotReleaseBoundMs<=0||receipt.slotReleaseBoundMs>250||!Number.isFinite(Date.parse(receipt.verifiedAt))||!Number.isFinite(Date.parse(receipt.expiresAt))||Date.parse(receipt.expiresAt)<=Date.parse(receipt.verifiedAt)||typeof read!=='function'||typeof processCurrent!=='function')throw Error('Exact game inference qualification unavailable');
 let lastWall=now(),invalidated=false;
 const current=()=>{
  if(invalidated)return false;
  try{
   const time=now();if(!Number.isSafeInteger(time)||time<lastWall){invalidated=true;return false;}lastWall=time;
   if(time<Date.parse(receipt.verifiedAt)||time>=Date.parse(receipt.expiresAt)||options.readReceipt!==read||options.processCurrent!==processCurrent||options.receiptSha256!==expectedSha||!isDeepStrictEqual(options.receipt,receipt))return false;
   const raw=read();if(!raw||raw.byteLength>32768||sha(raw)!==expectedSha||!isDeepStrictEqual(JSON.parse(Buffer.from(raw).toString('utf8')),receipt))return false;
   return processCurrent(structuredClone(receipt.process),structuredClone(receipt.selection))===true;
  }catch{return false;}
 };
 return selection=>{
  if(!isDeepStrictEqual(selection,receipt.selection)||!current())return null;
  const selected=structuredClone(selection),selectionDigest=gameInferenceSelectionDigest(selection);
  return {selectionDigest,qualificationRef:receipt.qualificationRef,preemptionBoundMs:receipt.preemptionBoundMs,slotReleaseBoundMs:receipt.slotReleaseBoundMs,current:()=>isDeepStrictEqual(selection,selected)&&current()};
 };
}
