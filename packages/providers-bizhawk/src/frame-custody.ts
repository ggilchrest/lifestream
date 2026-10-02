import {constants,closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {crc32,inflateSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import type * as G from '@lifestream/contracts/game-activity';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function boundedRead(fd:number,size:number):Buffer{const bytes=Buffer.alloc(size+1);let at=0;while(at<bytes.length){const count=readSync(fd,bytes,at,bytes.length-at,null);if(count===0)break;at+=count;}if(at!==size){bytes.fill(0);throw new GameFrameCustodyError();}return bytes.subarray(0,size);}
export class GameFrameCustodyError extends Error{constructor(){super('Game frame custody unavailable');}}
/** Only bounded, noninterlaced 8-bit RGB/RGBA PNGs. Verify every chunk CRC and
 * exact bounded decompression before bytes enter an image interpretation path. */
export function inspectGamePng(bytes:Buffer,maxLongEdge:number):{width:number;height:number}{
 const bad=()=>{throw new GameFrameCustodyError();};
 if(bytes.length<57||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();
 let at=8,width=0,height=0,channels=0,ended=false,seenData=false,dataEnded=false;const data:Buffer[]=[];
 while(at<bytes.length){if(at+12>bytes.length)bad();const length=bytes.readUInt32BE(at),end=at+12+length;if(end>bytes.length)bad();const type=bytes.toString('ascii',at+4,at+8),payload=bytes.subarray(at+8,at+8+length);if(crc32(bytes.subarray(at+4,at+8+length))!==bytes.readUInt32BE(at+8+length))bad();
  if(at===8&&type!=='IHDR'||at!==8&&type==='IHDR')bad();
  if(type==='IHDR'){if(length!==13)bad();width=payload.readUInt32BE(0);height=payload.readUInt32BE(4);channels=payload[9]===2?3:payload[9]===6?4:0;if(!width||!height||Math.max(width,height)>maxLongEdge||payload[8]!==8||!channels||payload[10]!==0||payload[11]!==0||payload[12]!==0)bad();}
  else if(type==='IDAT'){if(dataEnded)bad();seenData=true;data.push(payload);}
  else if(type==='IEND'){if(length!==0||end!==bytes.length||!seenData)bad();ended=true;}
  else{if(seenData)dataEnded=true;if(type==='acTL'||type==='fcTL'||type==='fdAT'||type[0]===type[0]!.toUpperCase()&&type!=='PLTE')bad();}
  at=end;
 }
 if(!ended)bad();const stride=width*channels+1,expected=stride*height;let decoded:Buffer;
 try{decoded=inflateSync(Buffer.concat(data),{maxOutputLength:expected});}catch{bad();}
 try{if(decoded!.length!==expected)bad();for(let row=0;row<height;row++)if(decoded![row*stride]!>4)bad();return {width,height};}finally{decoded!.fill(0);}
}
type Entry={scope:G.ActivityScope;screenshot:G.GameScreenshot;path:string;bytes:Buffer;expiresMono:number};
type FrameCustodyOptions={maxBytes:number;maxQueueBytes:number;maxLongEdge:number;maxFrames:number;maxTtlMs:number;current:(scope:G.ActivityScope)=>boolean};
/** Local files are a distinct custody lane, never base64 or paths in the control
 * protocol. This does not grant permission to disclose bytes to a model/recipient. */
export class GameFrameCustody{
 readonly directory:string;private entries=new Map<string,Entry>();private heldBytes=0;private disposed=false;private lastWall=Date.now();private expiryTimer:ReturnType<typeof setTimeout>|undefined;
 private readonly options:Readonly<FrameCustodyOptions>;
 get limits():{maxBytes:number;maxQueueBytes:number;maxLongEdge:number;maxFrames:number;maxTtlMs:number}{return {maxBytes:this.options.maxBytes,maxQueueBytes:this.options.maxQueueBytes,maxLongEdge:this.options.maxLongEdge,maxFrames:this.options.maxFrames,maxTtlMs:this.options.maxTtlMs};}
 constructor(directory:string,options:FrameCustodyOptions){
  this.options=Object.freeze({...options});
  if(!Number.isSafeInteger(options.maxQueueBytes)||options.maxQueueBytes<1||options.maxQueueBytes>67108864)throw new GameFrameCustodyError();
  if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1||options.maxBytes>2097152||!Number.isSafeInteger(options.maxLongEdge)||options.maxLongEdge<1||options.maxLongEdge>1024||!Number.isSafeInteger(options.maxFrames)||options.maxFrames<1||options.maxFrames>32||!Number.isSafeInteger(options.maxTtlMs)||options.maxTtlMs<1||options.maxTtlMs>30000)throw new GameFrameCustodyError();
  const path=resolve(directory),stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new GameFrameCustodyError();this.directory=realpathSync(path);
 }
 private valid(scope:G.ActivityScope):void{const now=Date.now();if(now<this.lastWall){this.dispose();throw new GameFrameCustodyError();}this.lastWall=now;if(this.disposed||!this.options.current(scope)||realpathSync(this.directory)!==this.directory)throw new GameFrameCustodyError();}
 ingest(observation:G.GameObservation):boolean{
  const added:string[]=[];
  let pendingBytes:Buffer|undefined;
  try{this.valid(observation.scope);this.expire();if(observation.screenshots.length!==1||this.entries.size+1>this.options.maxFrames)return false;
   for(const shot of observation.screenshots){const now=Date.now(),captured=Date.parse(shot.capturedAt),expires=Date.parse(shot.expiresAt);
    if(!uuid.test(shot.mediaRef)||shot.screenshotId!==shot.mediaRef||this.entries.has(shot.mediaRef)||shot.mediaType!=='image/png'||shot.frameNumber!==observation.frameNumber||shot.capturedAt!==observation.capturedAt||!Number.isFinite(captured)||!Number.isFinite(expires)||captured>now||expires<=now||expires-captured>this.options.maxTtlMs||shot.byteLength>this.options.maxBytes||this.heldBytes+shot.byteLength>this.options.maxQueueBytes)throw new GameFrameCustodyError();
    const path=join(this.directory,shot.mediaRef+'.png'),before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.size!==shot.byteLength||realpathSync(path)!==path)throw new GameFrameCustodyError();
    const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let bytes:Buffer;
    try{const current=fstatSync(fd);if(current.dev!==before.dev||current.ino!==before.ino||current.size!==shot.byteLength)throw new GameFrameCustodyError();bytes=boundedRead(fd,shot.byteLength);pendingBytes=bytes;const after=lstatSync(path);if(after.dev!==current.dev||after.ino!==current.ino||after.size!==current.size||after.mtimeMs!==current.mtimeMs)throw new GameFrameCustodyError();}finally{closeSync(fd);}
    const size=inspectGamePng(bytes!,this.options.maxLongEdge);if(size.width!==shot.width||size.height!==shot.height||createHash('sha256').update(bytes!).digest('hex')!==shot.sha256)throw new GameFrameCustodyError();
    this.valid(observation.scope);this.entries.set(shot.mediaRef,{scope:structuredClone(observation.scope),screenshot:structuredClone(shot),path,bytes:bytes!,expiresMono:performance.now()+Math.max(0,expires-Date.now())});pendingBytes=undefined;this.heldBytes+=bytes!.length;added.push(shot.mediaRef);
   }this.scheduleExpiry();return true;
  }catch{pendingBytes?.fill(0);for(const ref of added)this.remove(ref);return false;}
 }
 read(mediaRef:string,scope:G.ActivityScope):{screenshot:G.GameScreenshot;bytes:Buffer}{this.valid(scope);this.expire();const entry=this.entries.get(mediaRef);if(!entry||!isDeepStrictEqual(scope,entry.scope))throw new GameFrameCustodyError();return {screenshot:structuredClone(entry.screenshot),bytes:Buffer.from(entry.bytes)};}
 private remove(ref:string):void{const entry=this.entries.get(ref);if(!entry)return;this.heldBytes-=entry.bytes.length;entry.bytes.fill(0);this.entries.delete(ref);try{const stat=lstatSync(entry.path);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===entry.screenshot.byteLength&&stat.size<=this.options.maxBytes&&realpathSync(entry.path)===entry.path){const fd=openSync(entry.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let bytes:Buffer;try{bytes=boundedRead(fd,stat.size);}finally{closeSync(fd);}const digest=createHash('sha256').update(bytes!).digest('hex');bytes!.fill(0);if(digest===entry.screenshot.sha256)unlinkSync(entry.path);}}catch{/* No arbitrary file removal or authority inference on cleanup failure. */}}
 expire():void{for(const [ref,entry]of this.entries)if(Date.now()>=Date.parse(entry.screenshot.expiresAt)||performance.now()>=entry.expiresMono||!this.options.current(entry.scope))this.remove(ref);}
 private scheduleExpiry():void{clearTimeout(this.expiryTimer);if(this.disposed||this.entries.size===0)return;const remaining=Math.min(...[...this.entries.values()].map(e=>Math.min(Date.parse(e.screenshot.expiresAt)-Date.now(),e.expiresMono-performance.now())));this.expiryTimer=setTimeout(()=>{this.expire();this.scheduleExpiry();},Math.max(1,remaining));this.expiryTimer.unref();}
 dispose():void{this.disposed=true;clearTimeout(this.expiryTimer);for(const ref of this.entries.keys())this.remove(ref);}
}
