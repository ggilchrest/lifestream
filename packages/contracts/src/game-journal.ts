import {createContractValidator} from './validator.ts';
import type {CampaignJournal} from './game-activity.ts';
import {types,isDeepStrictEqual} from 'node:util';
const validator=createContractValidator();
/** Lossless bounded data only, before any getters or serialization can execute. */
export function boundedGameDataSnapshot(input:unknown,maximumBytes=262144):unknown|null{
 let nodes=0,bytes=0;const seen=new Set<unknown>();
 const plain=(value:unknown,depth=0):boolean=>{
  if(++nodes>8192||depth>24)return false;
  if(typeof value==='string'){bytes+=Buffer.byteLength(value)+2;return bytes<=maximumBytes;}
  if(value===null||typeof value==='boolean')return true;if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||types.isProxy(value)||seen.has(value))return false;const array=Array.isArray(value);if(Object.getPrototypeOf(value)!==(array?Array.prototype:Object.prototype))return false;
  seen.add(value);const keys=Reflect.ownKeys(value);if(keys.length>8192||array&&keys.length!==(value as unknown[]).length+1)return false;
  const valid=keys.every(key=>{if(typeof key!=='string')return false;bytes+=Buffer.byteLength(key)+4;const d=Object.getOwnPropertyDescriptor(value,key)!;return bytes<=maximumBytes&&(array&&key==='length'||d.enumerable===true&&Object.hasOwn(d,'value')&&plain(d.value,depth+1));});seen.delete(value);return valid;
 };
 try{if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>262144||!plain(input))return null;const text=JSON.stringify(input);if(Buffer.byteLength(text)>maximumBytes)return null;const value=JSON.parse(text);return isDeepStrictEqual(input,value)?value:null;}catch{return null;}
}
export function campaignJournalSnapshot(input:unknown,now:number,maximumBytes=262144):CampaignJournal|null{if(!Number.isSafeInteger(now)||now<0)return null;const journal=boundedGameDataSnapshot(input,maximumBytes) as CampaignJournal|null;return journal&&validateCampaignJournal(journal,now)?journal:null;}
export function validateCampaignJournal(journal:CampaignJournal,now:number):boolean{
 if(!validator.validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/CampaignJournal',journal).valid||journal.lifecycle!=='active'||Date.parse(journal.updatedAt)>now)return false;
 const entries=new Map(journal.entries.map(entry=>[entry.entryId,entry])),goals=new Map(journal.goals.map(goal=>[goal.goalId,goal]));
 const acyclic=(id:string)=>{const seen=new Set<string>();let current:string|null=id;while(current){if(seen.has(current))return false;seen.add(current);current=goals.get(current)?.supersedesGoalId??null;}return true;};
 return entries.size===journal.entries.length&&goals.size===journal.goals.length&&journal.summaryEntryIds.every(id=>entries.has(id))&&journal.entries.every(entry=>Date.parse(entry.recordedAt)<=Date.parse(journal.updatedAt)&&!(entry.kind==='humanAdvice'&&entry.epistemicKind!=='humanAdvice'))&&journal.goals.every(goal=>Date.parse(goal.updatedAt)<=Date.parse(journal.updatedAt)&&goal.sourceEntryIds.every(id=>entries.has(id))&&acyclic(goal.goalId)&&(goal.supersedesGoalId===null||goal.supersedesGoalId!==goal.goalId&&goals.get(goal.supersedesGoalId)?.status==='superseded'));
}
