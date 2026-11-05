import {performance} from 'node:perf_hooks';
import {channel} from 'node:diagnostics_channel';
import {readFileSync,writeFileSync,renameSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const TTL=86400000,MAX=131072,COUNT=256;
const events=new Set(['http_begin','http_failure','tcp_connected','http_dispatch']);
export const httpActivitySnapshot=()=>({loop:performance.eventLoopUtilization(),cpu:process.cpuUsage()});
export function httpActivitySince(before:ReturnType<typeof httpActivitySnapshot>){const loop=performance.eventLoopUtilization(before.loop),cpu=process.cpuUsage(before.cpu);return {eventLoopActiveMs:Math.max(0,Math.round(loop.active)),eventLoopIdleMs:Math.max(0,Math.round(loop.idle)),cpuUserMs:Math.max(0,Math.round(cpu.user/1000)),cpuSystemMs:Math.max(0,Math.round(cpu.system/1000))};}
export function createTransportObservation(directory:string,untilMs:number,now:()=>number=Date.now){
 const path=join(directory,'adapter.jsonl');let closed=false;
 const update=(record?:Record<string,unknown>)=>{try{
  const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o700)return;
  let rows:Record<string,unknown>[]=[];
  try{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>MAX)return;rows=readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;}
  rows=rows.filter(x=>typeof x.atMs==='number'&&x.atMs>=now()-TTL&&x.atMs<=now());if(record)rows.push(record);rows=rows.slice(-COUNT);
  let text=rows.map(x=>JSON.stringify(x)).join('\n');while(Buffer.byteLength(text)>MAX-1&&rows.length){rows.shift();text=rows.map(x=>JSON.stringify(x)).join('\n');}
  if(!text){try{unlinkSync(path);}catch{}return;}
  const temp=path+'.new';writeFileSync(temp,text+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path);
 }catch{/* Observation cannot change provider outcome. */}};
 const timer=setInterval(()=>update(),60000);timer.unref();update();
 return {emit(event:string,requestId:string|undefined,fields:Record<string,unknown>={},atMs=now()){
  if(closed||now()>untilMs||!events.has(event)||!Number.isSafeInteger(atMs)||atMs>now()||atMs<now()-TTL)return;
  const connectionEvent=event==='tcp_connected'||event==='http_dispatch';
  if(!connectionEvent&&(typeof requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)))return;
  if(connectionEvent&&(requestId!==undefined||!Number.isSafeInteger(fields.localPort)||Number(fields.localPort)<1||Number(fields.localPort)>65535))return;
  const safe:Record<string,unknown>={atMs,event,...(connectionEvent?{}:{requestId})};
  for(const name of ['elapsedMs','bytesRead','bytesWritten','localPort','eventLoopActiveMs','eventLoopIdleMs','cpuUserMs','cpuSystemMs']){const value=fields[name];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&(name!=='localPort'||value<=65535))safe[name]=value;}
  for(const name of ['aborted','timedOut'])if(typeof fields[name]==='boolean')safe[name]=fields[name];
  update(safe);
 },prune(){update();},close(){closed=true;clearInterval(timer);}};
}
/** Only closed numeric lifecycle markers; callbacks never retain request/headers. */
export function observeTtsConnections(observer:ReturnType<typeof createTransportObservation>,port=8787){
 let queued=0;
 const schedule=(event:string)=>(value:unknown)=>{try{
  const socket=(value as {socket?:{remotePort?:number;remoteAddress?:string;localPort?:number}})?.socket;
  if(socket?.remotePort!==port||socket.remoteAddress!=='127.0.0.1'||!Number.isInteger(socket.localPort)||queued>=256)return;
  const localPort=socket.localPort,atMs=Date.now();queued++;
  // No filesystem I/O in TCP connect/dispatch callbacks. Retain only numbers.
  setImmediate(()=>{queued--;try{observer.emit(event,undefined,{localPort},atMs);}catch{}});
 }catch{}};
 const connected=channel('undici:client:connected'),dispatch=channel('undici:client:sendHeaders'),onConnected=schedule('tcp_connected'),onDispatch=schedule('http_dispatch');
 connected.subscribe(onConnected);dispatch.subscribe(onDispatch);
 return ()=>{connected.unsubscribe(onConnected);dispatch.unsubscribe(onDispatch);};
}

let shared:ReturnType<typeof createTransportObservation>|undefined;
export function transportObservation(){
 const until=Number(process.env.LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS);
 if(!Number.isSafeInteger(until)||until<=0)return undefined;
 if(!shared){
  shared=createTransportObservation('/srv/lifestream/deployment/diagnostics/tts-transport-20261029',until);
  observeTtsConnections(shared);
 }
 return shared;
}

transportObservation(); // Also prune expired observations when the configured process starts.
