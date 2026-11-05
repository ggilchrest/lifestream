import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
const same=(a,b)=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
export async function regularFile(path,cap,{sealed=false}={}){
 const before=await lstat(path,{bigint:true});
 assert.ok(before.isFile()&&before.uid===1000n&&before.gid===1000n&&before.nlink===1n&&before.size<=BigInt(cap)&&(before.mode&0o077n)===0n,'Owner-only bounded regular file required');
 if(sealed)assert.equal(before.mode&0o777n,0o400n,'Sealed owner file required');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const opened=await fd.stat({bigint:true});assert.ok(same(before,opened));
  const body=await fd.readFile();assert.ok(body.length<=cap&&body.length===Number(before.size)&&same(opened,await fd.stat({bigint:true}))&&same(opened,await lstat(path,{bigint:true})));
  return body;
 }finally{await fd.close();}
}

export async function inspectOwnerFile(path,cap){
 const before=await lstat(path,{bigint:true});
 assert.ok(before.isFile()&&before.uid===1000n&&before.gid===1000n&&before.nlink===1n&&before.size<=BigInt(cap)&&(before.mode&0o077n)===0n,'Owner-only bounded regular file required');
 return before;
}
