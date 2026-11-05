import {types} from 'node:util';
import {nativeSourceException} from './native-source-witness.ts';

/** PRIVATE original-error retention only. Never a public diagnostic/archive DTO.
 * No properties are invoked, no I/O occurs, and no stdout/argv/environment is copied. */
export type NativeOriginalError=Readonly<{
 exceptionClass:string;message?:string;stack?:string;code?:string|number;
 signal?:string;killed?:boolean;stderr?:string;cause?:NativeOriginalError;
}>;
const errnos=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOTDIR','ELOOP','ENOSPC','EMFILE','ENFILE','EPIPE','ECONNREFUSED','ECONNRESET','EADDRINUSE','ETIMEDOUT','EIO']);
const signals=new Set(['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGPIPE','SIGINT','SIGHUP','SIGBUS','SIGILL','SIGFPE','SIGQUIT']);
const assignment=/((?:["']?)(?:authorization|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|token|password|secret|pairing[_ -]?secret)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}\]]+)/gi;
function privateText(value:string,maximum:number):string{
 // Avoid scanning an arbitrarily large exception body. Oversize stderr is
 // omitted entirely by the caller, rather than retained through this fallback.
 if(value.length>maximum*4)return '[REDACTED: oversized error text]';
 let text=value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ')
  .replace(/\bBearer\s+[^\s,;"'<>]+/gi,'Bearer [REDACTED]')
  .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s?#]+@/g,'$1[REDACTED]@')
  .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g,'$1=[REDACTED]')
  .replace(assignment,'$1[REDACTED]')
  .replace(/[a-fA-F0-9]{32,}/g,'[REDACTED]')
  .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g,'[REDACTED]');
 const raw=Buffer.from(text,'utf8');if(raw.length>maximum)text=raw.subarray(0,maximum).toString('utf8').replace(/\ufffd$/,'');return text;
}
function own(value:object,key:string):unknown{
 const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}
export function captureNativeOriginalError(error:unknown,options:Readonly<{captureStderr?:boolean}>={}):NativeOriginalError{
 // Options are trusted caller data, but their optional flag is still read from
 // an own data descriptor so an accidental accessor cannot run in cleanup.
 let stderr=false;try{stderr=!!options&&!types.isProxy(options)&&own(options,'captureStderr')===true;}catch{}
 const seen=new WeakSet<object>();
 const capture=(value:unknown,depth:number):NativeOriginalError=>{
  const out:{exceptionClass:string;message?:string;stack?:string;code?:string|number;signal?:string;killed?:boolean;stderr?:string;cause?:NativeOriginalError}={exceptionClass:nativeSourceException(value)};
  try{
   if(typeof value==='string'){out.message=privateText(value,2048);return Object.freeze(out);}
   if(!value||typeof value!=='object'||types.isProxy(value)||seen.has(value))return Object.freeze(out);seen.add(value);
   const message=own(value,'message'),stack=own(value,'stack'),code=own(value,'code'),signal=own(value,'signal'),killed=own(value,'killed');
   if(typeof message==='string')out.message=privateText(message,2048);if(typeof stack==='string')out.stack=privateText(stack,8192);
   if(typeof code==='string'&&errnos.has(code)||typeof code==='number'&&Number.isSafeInteger(code)&&code>=0&&code<=255)out.code=code as string|number;
   if(typeof signal==='string'&&signals.has(signal))out.signal=signal;if(typeof killed==='boolean')out.killed=killed;
   if(stderr){const detail=own(value,'stderr');if(typeof detail==='string'&&detail.length<=8192&&Buffer.byteLength(detail,'utf8')<=8192)out.stderr=privateText(detail,8192);}
   if(depth<2){const cause=own(value,'cause');if(cause!==undefined)out.cause=capture(cause,depth+1);}
  }catch{}return Object.freeze(out);
 };
 return capture(error,0);
}
export const serializeNativeOriginalError=captureNativeOriginalError;
