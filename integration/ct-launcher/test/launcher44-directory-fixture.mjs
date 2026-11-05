import assert from 'node:assert/strict';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
export async function directory(path,privateRoot=false){
 let cursor='/';for(const part of path.split('/').filter(Boolean)){
  cursor=join(cursor,part);const stat=await lstat(cursor);
  assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Real directories required');
  try{await lstat(join(cursor,'.git'));throw Error('Operator files and state must remain outside Git');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(privateRoot&&(cursor.startsWith('/srv/lifestream/workspace/runtime-state/real-daily/')||cursor.startsWith('/srv/lifestream/deployment/state/daily')||['/srv/lifestream/deployment','/srv/lifestream/deployment/state','/srv/lifestream/deployment/state/lifestream','/srv/lifestream/deployment/state/presentation-catalog'].some(path=>cursor===path)||cursor.startsWith('/srv/lifestream/deployment/state/lifestream/')||cursor.startsWith('/srv/lifestream/deployment/state/presentation-catalog/')))assert.ok(stat.uid===1000&&stat.gid===1000&&(stat.mode&0o777)===0o700,'Preserved state directories must be owner-only');
 }
}
