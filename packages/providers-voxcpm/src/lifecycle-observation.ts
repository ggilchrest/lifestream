/** Optional scalar lifecycle summaries. Write success never establishes peer receipt. */
import {lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
const HOUR=3_600_000, MAX_BYTES=131072, MAX_ROWS=256, MAX_ROW=2048, MAX_PENDING=32;
const identity=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const phases=new Set(['request','read','parse','validate']);
const outcomes=new Set(['completed','failed','cancelled','timedOut','providerRejected']);
const numbers=new Set(['attempt','requestBodyBytes','headersMs','elapsedMs','frames','samples']);
export type ClientSummary={attempt:number;requestBodyBytes:number;headersMs:number|null;elapsedMs:number;phase:string;preAudioSeen:boolean;frames:number;samples:number;outcome:string};
const count=(n:number)=>Math.min(2147483647,Math.max(0,Math.floor(n)));
/** Reject accessors and unknown keys without invoking getters or serializing input. */
export function safeClientRow(input:unknown):Record<string,unknown>|undefined {
 try {
  if(!input||Object.getPrototypeOf(input)!==Object.prototype)return;
  const descriptors=Object.getOwnPropertyDescriptors(input),row:Record<string,unknown>={};
  const required=['version','side','atMs','requestId','attempt','requestBodyBytes','headersMs','elapsedMs','phase','preAudioSeen','frames','samples','outcome','socketCountersAvailable'];
  if(Object.keys(descriptors).length!==required.length)return;
  for(const key of required){const d=descriptors[key];if(!d||!('value' in d))return;row[key]=d.value;}
  if(row.version!==1||row.side!=='client'||row.socketCountersAvailable!==false||typeof row.requestId!=='string'||row.requestId.length!==73||!identity.test(row.requestId)||typeof row.atMs!=='number'||!Number.isSafeInteger(row.atMs)||row.atMs<0)return;
  if(typeof row.phase!=='string'||!phases.has(row.phase)||typeof row.outcome!=='string'||!outcomes.has(row.outcome)||typeof row.preAudioSeen!=='boolean')return;
  for(const key of numbers){const n=row[key];if(key==='headersMs'&&n===null)continue;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>2147483647)return;}
  if(Number(row.attempt)>2||Number(row.elapsedMs)>HOUR||(row.headersMs!==null&&Number(row.headersMs)>HOUR))return;
  return Object.freeze(row);
 }catch{return;}
}
export function createLifecycleObserver(options:{directory:string;untilMs?:number;wall?:()=>number;mono?:()=>number;timers?:boolean}) {
 const wall=options.wall??Date.now,mono=options.mono??(()=>performance.now());
 const path=join(options.directory,'adapter.jsonl'),temp=path+'.new';
 const started=mono(),duration=(options.untilMs??0)-wall();
 let closed=false,inflight=0,pending:Record<string,unknown>[]=[],scheduled=false;
 let privateDirectory=false;try{const st=lstatSync(options.directory);privateDirectory=st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid?.()&&(st.mode&0o777)===0o700;}catch{}
 const enabled=privateDirectory&&Number.isSafeInteger(options.untilMs)&&duration>0&&duration<=HOUR;
 const active=()=>enabled&&!closed&&wall()<(options.untilMs??0)&&mono()-started<duration;
 const directorySafe=()=>{const st=lstatSync(options.directory);return st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid?.()&&(st.mode&0o777)===0o700;};
 const fileSafe=(p:string)=>{const st=lstatSync(p);return st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid?.()&&(st.mode&0o777)===0o600&&st.size<=MAX_BYTES;};
 const existsSafe=(p:string)=>{try{return fileSafe(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;return false;}};
 const removeSafe=(p:string)=>{try{if(directorySafe()&&existsSafe(p))unlinkSync(p);}catch{/* No observer failure escapes. */}};
 const remove=()=>{removeSafe(path);removeSafe(temp);};
 const pruneTemp=()=>{try{
  if(!directorySafe()||!existsSafe(temp))return;
  let stale=lstatSync(temp).mtimeMs<=wall()-HOUR;
  try{const rows=readFileSync(temp,'utf8').trim().split('\n').filter(Boolean).map(x=>safeClientRow(JSON.parse(x)));stale ||= rows.some(x=>x!==undefined&&Number(x.atMs)<=wall()-HOUR);}catch{/* Partial write: bounded file mtime supplies the cleanup age. */}
  if(stale)removeSafe(temp);
 }catch{}};
 const update=(rowsToAdd:Record<string,unknown>[])=>{try{
  if(!directorySafe())return;
  const safe=existsSafe(path);if(safe===false)return;
  let rows:Record<string,unknown>[]=[];
  if(safe){const parsed=readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(x=>safeClientRow(JSON.parse(x)));if(parsed.some(x=>!x))return;rows=parsed as Record<string,unknown>[];}
  const previousCount=rows.length;
  rows=rows.filter(x=>Number(x.atMs)>wall()-HOUR&&Number(x.atMs)<=wall());
  if(rowsToAdd.length===0&&rows.length===previousCount)return;
  rows.push(...rowsToAdd);rows=rows.slice(-MAX_ROWS);
  let text=rows.map(x=>JSON.stringify(x)+'\n').join('');while(Buffer.byteLength(text)>MAX_BYTES){rows.shift();text=rows.map(x=>JSON.stringify(x)+'\n').join('');}
  if(!text){if(safe)unlinkSync(path);return;}
  let created=false;
  try{
   // Separate exclusive creation so a partial write failure still has an owned cleanup path.
   const fd=openSync(temp,'wx',0o600);created=true;
   try{writeFileSync(fd,text);}finally{closeSync(fd);}
   renameSync(temp,path);
  }catch{/* Existing/unsafe temporary file is not replaced. */}
  finally{if(created)removeSafe(temp);}
 }catch{/* Drop metadata only. */}};
 // Safe pruning does not require activation and never creates a missing directory.
 pruneTemp();update([]);
 let deadlineTimer:NodeJS.Timeout|undefined;
 const expire=()=>{if(!enabled)return true;if(!active()){closed=true;pending=[];remove();if(timer)clearInterval(timer);if(deadlineTimer)clearTimeout(deadlineTimer);return true;}return false;};
 const flush=()=>{scheduled=false;if(expire())return;const rows=pending;pending=[];if(rows.length)update(rows);};
 const timer=enabled&&options.timers!==false?setInterval(()=>{if(!expire())update([]);},Math.min(60000,Math.max(1,duration))):undefined;timer?.unref();
 const armExpiry=()=>{
  if(!active()) {expire();return;}
  const remaining=Math.min((options.untilMs??0)-wall(),duration-(mono()-started));
  deadlineTimer=setTimeout(()=>{if(!expire())armExpiry();},Math.max(1,Math.ceil(remaining)));deadlineTimer.unref();
 };
 if(enabled&&options.timers!==false)armExpiry();
 const close=()=>{closed=true;pending=[];if(timer)clearInterval(timer);if(deadlineTimer)clearTimeout(deadlineTimer);if(enabled)remove();};
 return {begin(requestId:string){
  try{if(!active()||inflight>=32||typeof requestId!=='string'||requestId.length!==73||!identity.test(requestId))return;inflight++;let finished=false;
   return {finish(summary:ClientSummary){try{
    if(finished)return;finished=true;inflight--;if(!active())return;
    const row=safeClientRow({version:1,side:'client',atMs:wall(),requestId,attempt:summary.attempt,requestBodyBytes:count(summary.requestBodyBytes),headersMs:summary.headersMs===null?null:Math.min(HOUR,count(summary.headersMs)),elapsedMs:Math.min(HOUR,count(summary.elapsedMs)),phase:summary.phase,preAudioSeen:summary.preAudioSeen,frames:count(summary.frames),samples:count(summary.samples),outcome:summary.outcome,socketCountersAvailable:false});
    if(!row||Buffer.byteLength(JSON.stringify(row))>MAX_ROW||pending.length>=MAX_PENDING)return;
    pending.push(row);if(!scheduled){scheduled=true;setImmediate(flush);}
   }catch{/* Caller cleanup and terminal are independent of diagnostics. */}}};
  }catch{return;}
 },flush,close};
}
const observer=createLifecycleObserver({directory:'/srv/lifestream/deployment/diagnostics/tts-lifecycle-v1',untilMs:Number(process.env.LIFESTREAM_TTS_LIFECYCLE_UNTIL_MS)});
process.once('exit',()=>observer.close());
export const lifecycleObservation=()=>observer;
