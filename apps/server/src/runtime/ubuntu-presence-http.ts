import {canonicalPresenceDependenciesAvailable} from './canonical-presence-owners.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {LocalContext} from '../auth/local-auth.ts';
import {UbuntuPresenceHostError,unavailableUbuntuPresenceStatus,unavailableUbuntuPresenceSetup,validUbuntuSetupAction,type UbuntuPresenceHost,type UbuntuPresenceCommand} from './ubuntu-presence-host-factory.ts';

const root='/api/runtime/v1/camera-presence';
export const isUbuntuPresencePath=(path:string)=>path===root||path.startsWith(root+'/');
export type UbuntuPresenceHttpPorts={configurationSupplied?:boolean;host:()=>(Pick<UbuntuPresenceHost,'status'|'command'>&Partial<Pick<UbuntuPresenceHost,'setup'|'setupOperation'|'submitFrame'/*BEGIN_CAMERA1_HTTP_TYPE*/|'cancelNativeFrame'/*END_CAMERA1_HTTP_TYPE*/>>)|null;authenticate:(request:IncomingMessage)=>LocalContext;csrf:(context:LocalContext,token:string)=>void};
const json=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));};
async function body(request:IncomingMessage,setup=false):Promise<unknown>{
 const chunks:Buffer[]=[];let size=0;
 try{for await(const chunk of request.iterator({destroyOnReturn:false})){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>4096)throw new UbuntuPresenceHostError(413,'camera_presence_body_too_large');chunks.push(bytes);}
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(setup){if(!validUbuntuSetupAction(value))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_setup');return value;}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!=='expectedRevision|idempotencyKey|operation')throw new UbuntuPresenceHostError(422,'camera_presence_invalid_request');
  const v=value as Record<string,unknown>;if(!['stop','revoke'].includes(String(v.operation))||!Number.isSafeInteger(v.expectedRevision)||(v.expectedRevision as number)<1||typeof v.idempotencyKey!=='string'||!/^[-a-zA-Z0-9_]{16,80}$/.test(v.idempotencyKey))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_request');
  return v as UbuntuPresenceCommand;
 }catch(error){request.resume();if(error instanceof UbuntuPresenceHostError)throw error;throw new UbuntuPresenceHostError(422,'camera_presence_invalid_request');}
 finally{for(const chunk of chunks)chunk.fill(0);}
}

async function frameBody(request:IncomingMessage):Promise<Buffer>{
 const chunks:Buffer[]=[];let size=0,result:Buffer|undefined;
 try{for await(const chunk of request.iterator({destroyOnReturn:false})){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>2*1024*1024){bytes.fill(0);throw new UbuntuPresenceHostError(413,'camera_presence_frame_too_large');}chunks.push(bytes);}if(size<4)throw new UbuntuPresenceHostError(422,'camera_presence_invalid_frame');result=Buffer.concat(chunks);return result;}
 catch(error){request.resume();result?.fill(0);throw error;}finally{for(const chunk of chunks)chunk.fill(0);}
}
// Preserve legacy fixed-point encodings; canonical Number strings retain the
// browser's exact monotonic timestamp without rounding its custody interval.
const numeric=(v:unknown)=>typeof v==='string'&&v.length<=32&&Number.isFinite(Number(v))&&Number(v)>=0&&(/^[0-9]{1,16}(?:\.[0-9]{1,6})?$/.test(v)||String(Number(v))===v);

/** The original server checks Host/Origin first. No browser body can supply
 * device, identity, consent, permission, retention, endpoint or frame authority.
 * Setup/actions require independently configured host owners; default setup
 * stays unavailable. No first-permission request or automatic capture is made. */
export async function handleUbuntuPresenceHttp(ports:UbuntuPresenceHttpPorts,request:IncomingMessage,response:ServerResponse,path:string):Promise<void>{
 const context=ports.authenticate(request),method=request.method??'GET';
 if(request.url?.includes('?'))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_query');
 if(path!==root){
  if(![root+'/setup',root+'/operations',root+'/frame'].includes(path))throw new UbuntuPresenceHostError(404,'camera_presence_not_found');
  const host=ports.host();
  if(path===root+'/setup'){if(method!=='GET')throw new UbuntuPresenceHostError(405,'camera_presence_method_unavailable');return json(response,200,host?.setup?.(context)??unavailableUbuntuPresenceSetup());}
  if(method!=='POST')throw new UbuntuPresenceHostError(405,'camera_presence_method_unavailable');ports.csrf(context,String(request.headers['x-lifestream-csrf']??''));
  if(path===root+'/operations'){
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type']??'')))throw new UbuntuPresenceHostError(415,'camera_presence_unsupported_media');const value=await body(request,true);
   if(!host?.setupOperation)throw new UbuntuPresenceHostError(503,'camera_presence_setup_unavailable');if(!validUbuntuSetupAction(value))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_setup');
   /*BEGIN_CAMERA1_HTTP*/const pending=value.operation==='captureNativeFrame',channelId=pending?value.channelId:null;const onClose=()=>{if(!response.writableEnded&&channelId)host.cancelNativeFrame?.(context,channelId);};if(pending)response.once('close',onClose);
   try{/*END_CAMERA1_HTTP*/const result=await host.setupOperation(context,value);return json(response,result.state==='unavailable'?503:200,result);/*BEGIN_CAMERA1_HTTP_FINALLY*/}finally{if(pending)response.removeListener('close',onClose);}/*END_CAMERA1_HTTP_FINALLY*/
  }
  if(request.headers['content-type']!=='image/jpeg')throw new UbuntuPresenceHostError(415,'camera_presence_unsupported_media');
  const keys=['x-lifestream-presence-channel','x-lifestream-presence-sequence','x-lifestream-presence-captured-monotonic-ms'];if(Object.keys(request.headers).some(k=>k.startsWith('x-lifestream-presence-')&&!keys.includes(k)))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_frame');
  const channel=request.headers[keys[0]!],sequence=request.headers[keys[1]!],captured=request.headers[keys[2]!];if(typeof channel!=='string'||!/^[a-f0-9]{64}$/.test(channel)||sequence!=='1'||!numeric(captured))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_frame');
  if(!host?.submitFrame)throw new UbuntuPresenceHostError(503,'camera_presence_setup_unavailable');const bytes=await frameBody(request);
  try{const result=await host.submitFrame(context,{channelId:channel,sequence:1,capturedMonotonicMs:Number(captured)},bytes);return json(response,result.state==='unavailable'?503:result.state==='incomplete'?202:200,result);}finally{bytes.fill(0);}
 }
 if(method==='GET'){const host=ports.host(),status=host?.status(context)??unavailableUbuntuPresenceStatus();return json(response,200,{...status,readiness:{configuration:ports.configurationSupplied===false?'notConfigured':host||ports.configurationSupplied===true?'configured':'unknown',dependencies:canonicalPresenceDependenciesAvailable()?'available':'unavailable'}});}
 if(method!=='POST')throw new UbuntuPresenceHostError(405,'camera_presence_method_unavailable');
 ports.csrf(context,String(request.headers['x-lifestream-csrf']??''));if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type']??'')))throw new UbuntuPresenceHostError(415,'camera_presence_unsupported_media');const input=await body(request),host=ports.host();
 if(!host)throw new UbuntuPresenceHostError(503,'camera_presence_unavailable');
 const result=await host.command(context,input as UbuntuPresenceCommand);return json(response,result.state==='pending'||result.state==='incomplete'?202:result.state==='unavailable'?503:200,result);
}
