import type {IncomingMessage,ServerResponse} from 'node:http';
import {GAME_HOST_BASE_PATH,GAME_HOST_LIMITS} from '@lifestream/contracts/game-host';
import {GameHostError} from './game-host-port.ts';
import type {GameHostActor,GameHostPort} from './game-host-port.ts';

export const isGameHostPath=(path:string)=>path===GAME_HOST_BASE_PATH||path.startsWith(GAME_HOST_BASE_PATH+'/');
function reply(response:ServerResponse,status:number,body:unknown){const bytes=Buffer.from(JSON.stringify(body));if(bytes.length>GAME_HOST_LIMITS.messageBytes)throw new GameHostError(503,'game_host_unavailable');response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':bytes.length});response.end(bytes);}
async function body(request:IncomingMessage):Promise<unknown>{
 const length=request.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)>GAME_HOST_LIMITS.messageBytes))throw new GameHostError(413,'game_host_message_too_large');
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??''))throw new GameHostError(400,'invalid_game_host_message');
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let size=0,done=false;
  const finish=(error?:GameHostError,value?:unknown)=>{if(done)return;done=true;cleanup();if(error){request.pause();reject(error);}else resolve(value);};
  const data=(chunk:Buffer)=>{size+=chunk.length;if(size>GAME_HOST_LIMITS.messageBytes){finish(new GameHostError(413,'game_host_message_too_large'));return;}chunks.push(chunk);};
  const end=()=>{try{finish(undefined,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))));}catch{finish(new GameHostError(400,'invalid_game_host_message'));}};
  const aborted=()=>finish(new GameHostError(400,'invalid_game_host_message'));
  const timer=setTimeout(aborted,5000);timer.unref();
  const cleanup=()=>{clearTimeout(timer);request.removeListener('data',data);request.removeListener('end',end);request.removeListener('error',aborted);request.removeListener('aborted',aborted);};
  request.on('data',data);request.once('end',end);request.once('error',aborted);request.once('aborted',aborted);
 });
}
async function pngBody(request:IncomingMessage):Promise<Buffer>{
 if(request.headers['content-type']!=='image/png')throw new GameHostError(400,'invalid_game_frame');
 const length=request.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)<1||Number(length)>2097152))throw new GameHostError(413,'game_host_frame_too_large');
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let size=0,done=false;
  const finish=(error?:GameHostError)=>{if(done)return;done=true;cleanup();if(error){request.pause();reject(error);}else resolve(Buffer.concat(chunks,size));for(const chunk of chunks)chunk.fill(0);};
  const data=(chunk:Buffer)=>{size+=chunk.length;if(size>2097152){chunk.fill(0);finish(new GameHostError(413,'game_host_frame_too_large'));return;}chunks.push(chunk);};
  const end=()=>finish(size?undefined:new GameHostError(400,'invalid_game_frame'));
  const aborted=()=>finish(new GameHostError(400,'invalid_game_frame'));
  const timer=setTimeout(aborted,5000);timer.unref();
  const cleanup=()=>{clearTimeout(timer);request.removeListener('data',data);request.removeListener('end',end);request.removeListener('error',aborted);request.removeListener('aborted',aborted);};
  request.on('data',data);request.once('end',end);request.once('error',aborted);request.once('aborted',aborted);
 });
}
/** Existing caller-owned local auth/CSRF checks run before bounded JSON ingress. */
export async function handleGameHostHttp(port:GameHostPort|undefined,request:IncomingMessage,response:ServerResponse,path:string,authenticate:(administration:boolean)=>GameHostActor){
 try{
  if(!port)throw new GameHostError(404,'game_host_disabled');
  const operation=path.slice(GAME_HOST_BASE_PATH.length+1);
  if(operation.startsWith('frame/')){
   const parts=operation.split('/'),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
   if(request.method!=='POST'||request.url?.includes('?')||parts.length!==5||!uuid.test(parts[1]!)||!uuid.test(parts[2]!)||!/^[a-f0-9]{64}$/.test(parts[3]!)||!uuid.test(parts[4]!))throw new GameHostError(400,'invalid_game_frame');
   const actor=authenticate(false);port.beginOwnedFrameUpload(actor,parts[1]!,parts[2]!,parts[3]!,parts[4]!);let bytes:Buffer|undefined;
   try{bytes=await pngBody(request);port.finishOwnedFrameUpload(actor,parts[1]!,parts[2]!,bytes);reply(response,200,{accepted:true});}
   catch(error){port.abortOwnedFrameUpload(parts[1]!,parts[2]!);throw error;}finally{bytes?.fill(0);}return;
  }
  if(request.method!=='POST'||!['attach','next','admit','result','detach','shutdown'].includes(operation)||request.url?.includes('?'))throw new GameHostError(400,'invalid_game_host_message');
  const actor=authenticate(operation==='attach'),input=await body(request);
  let result:unknown;
  switch(operation){
   case 'attach':result=port.attach(actor,input);break;
   case 'admit':result=port.admit(actor,input);break;
   case 'result':result=port.complete(actor,input);break;
   case 'detach':result=port.detach(actor,input);break;
   case 'shutdown':result=port.shutdownReceipt(actor,input);break;
   case 'next':{
    const controller=new AbortController(),closed=()=>{if(!response.writableEnded)controller.abort();};response.once('close',closed);
    try{result=await port.next(actor,input,controller.signal);}finally{response.removeListener('close',closed);}break;
   }
  }
  reply(response,200,result);
 }catch(error){
  const auth=error as {status?:unknown;code?:unknown};
  const recognized=error instanceof GameHostError||typeof auth?.status==='number'&&typeof auth?.code==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(auth.code);
  const status=recognized?auth.status as number:503,code=recognized?auth.code as string:'game_host_unavailable';
  if(!response.destroyed&&!response.headersSent){response.setHeader('connection','close');reply(response,status,{error:code});}
 }
}
