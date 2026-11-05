/** DEFAULT OFF trusted in-process diagnostic. No HTTP/config/env activation. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {InferenceProvider,InferenceRequest,CtPrivateResponseCapture} from '@lifestream/runtime/inference';
import {assertCtRequestProvenance,type CtRequestProvenance} from './ct-request-provenance.ts';
export type CtPrivateCaptureOptions=Readonly<{enabled:true;jobId:string;runId:string;directory:string}>;
const MAX=1048576,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const need=(v:unknown):void=>{if(!v)throw Error('CT private capture unavailable');};
const keys=(v:object,w:string[])=>need(Object.keys(v).sort().join(',')===w.sort().join(','));
const obviousSecret=/(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|["']?(?:api[_-]?key|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?[^\s"'\\,;}]{1,})/i;
const sig=(s:fs.Stats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
export function createCtPrivateRequestCapture(options?:CtPrivateCaptureOptions){
 if(options===undefined)return undefined;
 keys(options,['enabled','jobId','runId','directory']);need(options.enabled===true&&uuid.test(options.jobId)&&uuid.test(options.runId)&&path.isAbsolute(options.directory)&&path.resolve(options.directory)===options.directory);
 const config=Object.freeze({...options});let used=false;
 return Object.freeze({jobId:config.jobId,runId:config.runId,
 capture(proof:CtRequestProvenance,request:InferenceRequest,provider:InferenceProvider,serializedBody:string,runId:string){
  need(!used);used=true;let directory:number|undefined,custodyEstablished=false;let stage:'input'|'directory'|'write'|'currentness'='input';
  const file=(name:string,bytes:Buffer)=>{
   need(directory!==undefined);const target='/proc/self/fd/'+directory+'/'+name;
   const fd=fs.openSync(target,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o400);
   try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);const actual=fs.fstatSync(fd),named=fs.lstatSync(target);need(actual.isFile()&&actual.uid===process.getuid!()&&actual.gid===process.getgid!()&&actual.nlink===1&&(actual.mode&0o777)===0o400&&actual.size===bytes.length&&sig(actual)===sig(named));const checked=Buffer.alloc(bytes.length+1);const n=fs.readSync(fd,checked,0,checked.length,0);need(n===bytes.length&&checked.subarray(0,n).equals(bytes)&&sig(actual)===sig(fs.fstatSync(fd)));return {name,sha256:sha(bytes),bytes:bytes.length};}finally{fs.closeSync(fd);}
  };
  try{
   assertCtRequestProvenance(proof,request,provider);need(runId===config.runId&&request.executionMode==='live');
   need(request.sections.length===9&&request.sections[8]?.kind==='userInput'&&request.sections[8].content==='');
   need(request.sections[3]?.content.startsWith(`assistant=${request.scope.assistantId};session=${request.scope.sessionId};interaction=${request.scope.interactionId};endpoint=${request.scope.endpointId??'none'};origin=activityStep;`));
   keys(request.scope,['assistantId','sessionId','interactionId','endpointId']);keys(request.manifest,['schemaVersion','sections','tokenizer']);
   for(const section of request.sections)keys(section,['kind','content','trusted','sourceRevision','sourceRef','contentDigest','redaction','tokenCount']);
   for(const section of request.manifest.sections)keys(section,['kind','sourceRevision','sourceRef','contentDigest','redaction','tokenCount']);
   need(request.sections.every(section=>!obviousSecret.test(section.content)));
   const allowed=['scope','sections','manifest','deadlineAt','executionMode',...(request.maximumOutputTokens===undefined?[]:['maximumOutputTokens']),...(request.responseFormat===undefined?[]:['responseFormat'])];keys(request,allowed);
   const original=Buffer.from(JSON.stringify(request));need(original.length<=MAX&&sha(original)===proof.requestDigest&&typeof serializedBody==='string'&&Buffer.byteLength(serializedBody)<=MAX);
   need(!obviousSecret.test(original.toString('utf8'))&&!obviousSecret.test(serializedBody));const body=JSON.parse(serializedBody);keys(body,['model','stream','messages',...(request.responseFormat===undefined?[]:['response_format']),...(request.maximumOutputTokens===undefined?[]:['max_tokens']),...(body.chat_template_kwargs===undefined?[]:['chat_template_kwargs'])]);
   need(body.model===proof.provider.model&&body.stream===true&&isDeepStrictEqual(body.response_format,request.responseFormat)&&body.max_tokens===request.maximumOutputTokens);
   if(body.chat_template_kwargs!==undefined)need(isDeepStrictEqual(body.chat_template_kwargs,{enable_thinking:false}));
   need(isDeepStrictEqual(body.messages,[{role:'system',content:request.sections.slice(0,4).map(s=>`[${s.kind}; trusted]\n${s.content}`).join('\n\n')},{role:'user',content:request.sections.slice(4).map(s=>`[${s.kind}; untrusted]\n${s.content}`).join('\n\n')}]));
   stage='directory';for(let ancestor=config.directory,count=0;;ancestor=path.dirname(ancestor)){need(++count<=64);try{fs.lstatSync(path.join(ancestor,'.git'));throw Error('CT private capture unavailable');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(path.dirname(ancestor)===ancestor)break;}need(fs.realpathSync(config.directory)===config.directory);directory=fs.openSync(config.directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const before=fs.fstatSync(directory);
   const sameDirectory=()=>{const now=fs.fstatSync(directory!),named=fs.lstatSync(config.directory);need(now.isDirectory()&&now.dev===before.dev&&now.ino===before.ino&&named.dev===before.dev&&named.ino===before.ino&&now.uid===process.getuid!()&&now.gid===process.getgid!()&&(now.mode&0o777)===0o700&&(named.mode&0o777)===0o700);};sameDirectory();need(fs.readdirSync('/proc/self/fd/'+directory).length===0);custodyEstablished=true;
   stage='write';const requestFile=file('finalized-request.private.json',original),providerBody=file('provider-post-body.private.json',Buffer.from(serializedBody));sameDirectory();
   stage='currentness';assertCtRequestProvenance(proof,request,provider);sameDirectory();
   const receipt={schemaVersion:'ct-private-request-capture/1',status:'CAPTURED',jobId:config.jobId,runId:config.runId,request:requestFile,providerBody,scope:'Only already-selected CT nine-section finalized request and exact serialized provider body; includes existing persona/prepared-memory/simulated-game context and inert provenance references. No headers/auth/browser storage/env/config secrets fetched.',exactSerializedProviderBody:true};
   file('capture.private.json',Buffer.from(JSON.stringify(receipt)+'\n'));fs.fsyncSync(directory);sameDirectory();
   // Keep only bounded response bytes in memory until terminal; no new fetch,
   // response headers or transport credentials are accepted by this interface.
   let responseClosed=false,responseBytes=0;const responseChunks:Buffer[]=[];
   const responseCapture:CtPrivateResponseCapture={
    append(bytes){need(!responseClosed&&bytes instanceof Uint8Array);if(bytes.byteLength===0)return;need(responseBytes+bytes.byteLength<=MAX);responseBytes+=bytes.byteLength;responseChunks.push(Buffer.from(bytes));},
    finish(metadata){
     need(!responseClosed);responseClosed=true;
     keys(metadata,['httpStatus','transportEof','parserTerminal']);need((metadata.httpStatus===null||Number.isInteger(metadata.httpStatus)&&metadata.httpStatus>=100&&metadata.httpStatus<=599)&&typeof metadata.transportEof==='boolean'&&['done','length','malformed','response_limit','http_error','cancelled','deadline','other','consumer_closed'].includes(metadata.parserTerminal));
     directory=fs.openSync(config.directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let responseCustodyEstablished=false;
     try{
      sameDirectory();responseCustodyEstablished=true;
      const raw=Buffer.concat(responseChunks),rawText=raw.toString('utf8');need(!obviousSecret.test(rawText));
      const finishReasons:string[]=[],usage:Record<string,number>[] = [],timings:Record<string,number>[] = [],returnedSettings:Record<string,number>[]=[];let parsedFrames=0,doneMarkers=0,malformedFrames=0;
      const numbers=(value:unknown,allowed:readonly string[],integer=false)=>{const result:Record<string,number>={};if(value&&typeof value==='object')for(const key of allowed){const v=(value as Record<string,unknown>)[key];if(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=2147483647&&(!integer||Number.isSafeInteger(v)))result[key]=v;}return result;};
      let checkedNodes=0;const checkStrings=(value:unknown,depth=0):void=>{need(++checkedNodes<=65536&&depth<=32);if(typeof value==='string')need(!obviousSecret.test(value));else if(value&&typeof value==='object')for(const item of Object.values(value))checkStrings(item,depth+1);};
      for(const line of rawText.split('\n'))if(line.startsWith('data: ')){
       const data=line.slice(6).trim();if(data==='[DONE]'){doneMarkers++;continue;}
       let parsed:any;try{parsed=JSON.parse(data);}catch{malformedFrames++;continue;}checkStrings(parsed);parsedFrames++;
       const reason=parsed?.choices?.[0]?.finish_reason;if(typeof reason==='string'){const safe=['stop','length','tool_calls','function_call','content_filter'].includes(reason)?reason:'other';if(!finishReasons.includes(safe))finishReasons.push(safe);}
       for(const [value,allowed,target,integer]of [[parsed?.usage,['prompt_tokens','completion_tokens','total_tokens'],usage,true],[parsed?.timings,['cache_n','prompt_n','prompt_ms','prompt_per_token_ms','prompt_per_second','predicted_n','predicted_ms','predicted_per_token_ms','predicted_per_second'],timings,false],[parsed?.generation_settings,['seed','temperature','top_k','top_p','min_p','repeat_penalty','presence_penalty','frequency_penalty','n_predict'],returnedSettings,false]]as const){const projected=numbers(value,allowed,integer);if(Object.keys(projected).length){need(target.length<64);target.push(projected);}}
      }
      const responseFile=file('provider-response.private.bin',raw);
      file('response.private.json',Buffer.from(JSON.stringify({schemaVersion:'ct-private-response-capture/1',jobId:config.jobId,runId:config.runId,status:metadata.transportEof?'HTTP_BODY_COMPLETE':'HTTP_BODY_PARTIAL',...metadata,response:responseFile,finishReasons,usage:usage.length?usage:null,timings:timings.length?timings:null,returnedSettings:returnedSettings.length?returnedSettings:null,realizedRandomSeed:'UNAVAILABLE_NOT_PROVEN_BY_RESPONSE',requestedSettings:{model:body.model,max_tokens:body.max_tokens??null,chat_template_kwargs:body.chat_template_kwargs??null,seed:'OMITTED',samplingOverrides:'OMITTED',stream_options:'OMITTED'},parsedFrames,doneMarkers,malformedFrames,meaning:'Exact received HTTP response-body bytes, not HTTP headers or transfer framing. Completion and parser acceptance are separate. Returned token/timing/settings projections are observations, not inferred effective defaults.'})+'\n'));fs.fsyncSync(directory);sameDirectory();
     }catch{if(responseCustodyEstablished)try{file('response.private.json',Buffer.from(JSON.stringify({schemaVersion:'ct-private-response-capture/1',status:'CAPTURE_FAILED',code:'ct_private_response_capture_unavailable'})+'\n'));}catch{}throw Error('CT private response capture unavailable');}
     finally{if(directory!==undefined){fs.closeSync(directory);directory=undefined;}responseChunks.length=0;}
    }
   };return {...receipt,responseCapture};
  }catch{
   // Never export exception text/paths, credentials, request text or stack.
   if(directory!==undefined&&custodyEstablished)try{file('capture.private.json',Buffer.from(JSON.stringify({schemaVersion:'ct-private-request-capture/1',status:'FAILED',code:'ct_private_capture_unavailable',stage})+'\n'));}catch{}
   throw Error('CT private capture unavailable');
  }finally{if(directory!==undefined){fs.closeSync(directory);directory=undefined;}}
 }
 });
}

export function assertCtPrivateCaptureJob(capture:ReturnType<typeof createCtPrivateRequestCapture>,runId:unknown,stateRoot:unknown):void{
 if(capture)need(runId===capture.runId&&stateRoot==='/srv/lifestream/workspace/runtime-state/ct-native-owner-'+capture.jobId);
}


/** Optional trusted local diagnostics follow server-selected run identities.
 * The ordinary application needs no capture directory or per-run launcher. */
export function createOrdinaryCtCaptureFactory(directory:string){
 need(typeof directory==='string'&&path.isAbsolute(directory)&&path.resolve(directory)===directory);
 const verify=()=>{
  need(fs.realpathSync(directory)===directory);const stat=fs.lstatSync(directory);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid!()&&stat.gid===process.getgid!()&&(stat.mode&0o777)===0o700);
  for(let ancestor=directory;;ancestor=path.dirname(ancestor)){try{fs.lstatSync(path.join(ancestor,'.git'));throw Error('CT private capture unavailable');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(path.dirname(ancestor)===ancestor)break;}
 };
 verify();
 return (runId:string,sessionScoped=false)=>{verify();need(typeof sessionScoped==='boolean');need(uuid.test(runId));const selected=path.join(directory,runId);fs.mkdirSync(selected,{mode:0o700});verify();const primary=createCtPrivateRequestCapture({enabled:true,jobId:runId,runId,directory:selected})!,captures=new Map<string,NonNullable<ReturnType<typeof createCtPrivateRequestCapture>>>();
  return Object.freeze({...primary,forInteraction(interactionId:string){verify();need(uuid.test(interactionId));const old=captures.get(interactionId);if(old)return old;need(captures.size<(sessionScoped?512:8));let capture=primary;if(captures.size){const child=path.join(selected,interactionId);fs.mkdirSync(child,{mode:0o700});capture=createCtPrivateRequestCapture({enabled:true,jobId:runId,runId,directory:child})!;}captures.set(interactionId,capture);return capture;}});
 };
}
