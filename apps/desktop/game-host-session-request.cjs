'use strict';
const ORIGIN='http://127.0.0.1:43182',MAX_BYTES=131072;
const FRAME_MAX_BYTES=2097152,FRAME_PATH=/^\/api\/runtime\/v1\/game-host\/frame\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const allowed=new Set(['/api/auth/v1/session','/api/runtime/v1/session-context','/api/runtime/v1/game-host/attach','/api/runtime/v1/game-host/next','/api/runtime/v1/game-host/admit','/api/runtime/v1/game-host/result','/api/runtime/v1/game-host/detach']);
/** Chromium session-bound requests with its documented origin option. Ordinary
 * session credentials are attached by Electron; no cookie getter/header access,
 * credential forwarding, browser security exception or renderer API is used. */
function createSessionBoundGameHostFetch(net,partition){
 if(typeof net?.request!=='function'||!partition)throw Error('game_host_session_unavailable');
 return (input,init)=>new Promise((resolve,reject)=>{
  let url;try{url=new URL(input);}catch{reject(Error('game_host_session_unavailable'));return;}
  const read=url.pathname==='/api/auth/v1/session'||url.pathname==='/api/runtime/v1/session-context';
  const frame=FRAME_PATH.test(url.pathname);
  if(typeof input!=='string'||url.origin!==ORIGIN||url.search||url.hash||url.username||url.password||(!allowed.has(url.pathname)&&!frame)||init?.method!==(read?'GET':'POST')||init.credentials!=='include'||init.redirect!=='error'||init.cache!=='no-store'||(!read&&(frame?(!Buffer.isBuffer(init.body)||!init.body.length||init.body.length>FRAME_MAX_BYTES||init.headers?.['content-type']!=='image/png'):(typeof init.body!=='string'||Buffer.byteLength(init.body)>MAX_BYTES)))){reject(Error('game_host_session_unavailable'));return;}
  let request,timer,finished=false;const chunks=[];let bytes=0;
  const finish=(error,response)=>{if(finished)return;finished=true;clearTimeout(timer);init.signal?.removeEventListener('abort',abort);if(error){request?.abort();reject(Error('game_host_session_unavailable'));}else resolve(response);};
  const abort=()=>finish(true);
  if(init.signal?.aborted){finish(true);return;}
  try{
   // Only fixed trusted headers are passed; Cookie/Authorization are never
   // accepted from callers. The broker retains CSRF solely in trusted main.
   const headers=read?{}:{'content-type':frame?'image/png':'application/json','origin':ORIGIN,'x-lifestream-csrf':init.headers?.['x-lifestream-csrf']};
   if(!read&&(typeof headers['x-lifestream-csrf']!=='string'||headers['x-lifestream-csrf'].length>256)){finish(true);return;}
   request=net.request({url:url.href,method:init.method,session:partition,origin:ORIGIN,headers,credentials:'include',redirect:'error',cache:'no-store',bypassCustomProtocolHandlers:true});
   init.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,5000);timer.unref?.();
   request.on('error',abort);request.on('redirect',abort);request.on('login',(_information,callback)=>callback());
   request.on('response',response=>{
    const single=value=>typeof value==='string'?value:Array.isArray(value)&&value.length===1?value[0]:undefined;
    const type=single(response.headers['content-type']),length=single(response.headers['content-length']);
    if(!/^application\/json(?:;|$)/i.test(type??'')||length&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES)){finish(true);return;}
    response.on('error',abort);response.on('aborted',abort);
    response.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>MAX_BYTES){finish(true);return;}chunks.push(Buffer.from(chunk));});
    response.on('end',()=>{if(finished)return;try{finish(false,new Response(Buffer.concat(chunks,bytes),{status:response.statusCode,headers:{'content-type':type,'cache-control':'no-store'}}));}catch{finish(true);}});
   });
   request.end(read?undefined:init.body);
  }catch{finish(true);}
 });
}
module.exports={createSessionBoundGameHostFetch};
