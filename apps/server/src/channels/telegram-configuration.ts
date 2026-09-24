import {lstat,open,realpath,stat} from 'node:fs/promises';
import {existsSync,constants} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import type {TelegramHostOptions} from '../index.ts';

type Configuration={schemaVersion:'1.0.0';botId:string;enabled:boolean;tokenRef:{kind:'env';name:string}};
const invalid=():never=>{throw Error('Invalid Telegram host configuration; use a private operator-local file with an environment token reference.');};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',');
/** Parse only the declared host fields. Browser identity, recipient consent,
 * condition policy and dispatch authority are not configurable through this file. */
export function parseTelegramConfiguration(value:unknown):Configuration{
 if(!object(value)||!keys(value,['schemaVersion','botId','enabled','tokenRef'])||value.schemaVersion!=='1.0.0'||typeof value.botId!=='string'||! /^[1-9][0-9]{0,15}$/.test(value.botId)||!Number.isSafeInteger(Number(value.botId))||typeof value.enabled!=='boolean'||!object(value.tokenRef)||!keys(value.tokenRef,['kind','name'])||value.tokenRef.kind!=='env'||typeof value.tokenRef.name!=='string'||!/^LIFESTREAM_[A-Z][A-Z0-9_]{0,95}$/.test(value.tokenRef.name))return invalid();
 return structuredClone(value) as Configuration;
}
export function telegramHostConfiguration(value:unknown,environment:NodeJS.ProcessEnv=process.env):TelegramHostOptions{
 const configuration=parseTelegramConfiguration(value);
 const token=()=>{const secret=environment[configuration.tokenRef.name];if(!secret||!new RegExp('^'+configuration.botId+':[A-Za-z0-9_-]{20,256}$').test(secret))return undefined;return secret;};
 if(configuration.enabled&&!token())throw Error('Enabled Telegram requires the matching bot token in its configured environment variable.');
 return {botId:configuration.botId,enabled:()=>configuration.enabled,token};
}
/** Configuration never supplies inline secrets, arbitrary URLs, transport code
 * or grant receipts. File checks precede bounded reading and avoid symlink races. */
export async function loadTelegramConfiguration(path:string,environment:NodeJS.ProcessEnv=process.env):Promise<TelegramHostOptions>{
 try{
  if(!isAbsolute(path))return invalid();
  const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.size>8192||(before.mode&0o077)!==0||typeof process.getuid==='function'&&before.uid!==process.getuid())return invalid();
  const canonical=await realpath(path);
  for(let p=dirname(canonical);;p=dirname(p)){if(existsSync(join(p,'.git')))return invalid();if(dirname(p)===p)break;}
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const current=await file.stat();if(current.dev!==before.dev||current.ino!==before.ino||current.size>8192||!current.isFile()||(current.mode&0o077)!==0)return invalid();
   const buffer=Buffer.alloc(8193),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>8192)return invalid();
   const after=await stat(path);if(after.dev!==current.dev||after.ino!==current.ino||after.mtimeMs!==current.mtimeMs||after.size!==current.size)return invalid();
   let value:unknown;try{value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}catch{return invalid();}
   return telegramHostConfiguration(value,environment);
  }finally{await file.close();}
 }catch{return invalid();}
}
