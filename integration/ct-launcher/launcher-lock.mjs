import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,lstat,stat,readFile,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const same=(a,b)=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const integer=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value);
const need=(condition,reason)=>assert.ok(condition,'launcher_lock_'+reason);
function regular(value,uid,gid,cap){
 need(value.isFile()&&value.uid===BigInt(uid)&&value.gid===BigInt(gid)&&value.nlink===1n&&(value.mode&0o777n)===0o600n&&value.size<=BigInt(cap),'unsafe_file');
}
async function processStart(pid){
 try{
  const text=await readFile(`/proc/${pid}/stat`,'utf8'),end=text.lastIndexOf(')'),fields=text.slice(end+2).trim().split(/\s+/);
  need(end>0&&Number(text.slice(0,text.indexOf(' ')))===pid&&integer(fields[19]),'uncertain_process_identity');
  return fields[19];
 }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function hostIdentity(){
 const text=await readFile('/proc/self/stat','utf8'),pid=Number(text.slice(0,text.indexOf(' '))),ticks=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/)[19];
 need(pid===process.pid&&integer(ticks)&&await processStart(process.pid)===ticks,'proc_namespace_mismatch');
 const namespace=await stat('/proc/self/ns/pid',{bigint:true}),byPid=await stat(`/proc/${process.pid}/ns/pid`,{bigint:true});
 need(namespace.dev===byPid.dev&&namespace.ino===byPid.ino,'proc_namespace_mismatch');
 const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();need(uuid(bootId),'uncertain_boot_identity');
 return {bootId,pidNamespaceDev:String(namespace.dev),pidNamespaceIno:String(namespace.ino),startTicks:ticks};
}
async function flock(handle){
 // The child inherits the same open file description on fd3. Its exit leaves
 // the flock held by our retained descriptor until this launcher closes it.
 await new Promise((accept,reject)=>{
  const child=spawn('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',handle.fd],env:{LANG:'C'}});
  child.once('error',reject);child.once('exit',(code,signal)=>code===0&&!signal?accept():reject(new Error('launcher_lock_guard_busy_or_unavailable')));
 });
}

/** Ubuntu only. The permanent guard inode serializes recovery and remains
 * kernel-locked through shutdown. Never unlink the guard. The exclusive marker
 * is retained so an older launcher still cannot start alongside this one. */
export async function acquireLauncherLock(stateDirectory,candidateId){
 const uid=process.getuid(),gid=process.getgid();
 need(uid===1000&&gid===1000&&resolve(stateDirectory)===stateDirectory&&await realpath(stateDirectory)===stateDirectory,'unsafe_directory');
 need(typeof candidateId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidateId),'invalid_candidate');
 const directoryIdentity=await lstat(stateDirectory,{bigint:true});
 need(directoryIdentity.isDirectory()&&directoryIdentity.uid===BigInt(uid)&&directoryIdentity.gid===BigInt(gid)&&(directoryIdentity.mode&0o777n)===0o700n,'unsafe_directory');
 const guardPath=join(stateDirectory,'real-daily.launcher.guard'),path=join(stateDirectory,'real-daily.launcher.lock');
 let guard,marker,markerIdentity,releasePromise;
 async function directoryCurrent(){const value=await lstat(stateDirectory,{bigint:true});need(value.isDirectory()&&value.dev===directoryIdentity.dev&&value.ino===directoryIdentity.ino&&value.uid===BigInt(uid)&&value.gid===BigInt(gid)&&(value.mode&0o777n)===0o700n&&await realpath(stateDirectory)===stateDirectory,'directory_changed');}
 async function guardCurrent(){await directoryCurrent();const fd=await guard.stat({bigint:true}),named=await lstat(guardPath,{bigint:true});regular(fd,uid,gid,0);regular(named,uid,gid,0);need(same(fd,named),'guard_changed');}
 async function readMarker(){
  const before=await lstat(path,{bigint:true});regular(before,uid,gid,4096);
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const opened=await fd.stat({bigint:true});need(same(before,opened),'marker_changed');const buffer=Buffer.alloc(4097),{bytesRead}=await fd.read(buffer,0,buffer.length,0),bytes=buffer.subarray(0,bytesRead);need(bytes.length===Number(opened.size)&&same(opened,await fd.stat({bigint:true}))&&same(opened,await lstat(path,{bigint:true})),'marker_changed');return {identity:opened,bytes,value:JSON.parse(bytes.toString('utf8'))};}finally{await fd.close();}
 }
 try{
  guard=await open(guardPath,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  regular(await guard.stat({bigint:true}),uid,gid,0);await flock(guard);await guardCurrent();
  const host=await hostIdentity();let recovered=null,existing;
  try{existing=await readMarker();}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing){
   const value=existing.value;
   need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===['schemaVersion','familyId','candidateId','stateDirectory','stateDev','stateIno','uid','gid','bootId','pidNamespaceDev','pidNamespaceIno','pid','startTicks','nonce'].sort().join(),'unproven_legacy_or_partial_marker');
   need(value.schemaVersion==='daily-launcher-lock:2.0.0'&&value.familyId==='native-daily'&&typeof value.candidateId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.candidateId)&&uuid(value.nonce)&&Number.isSafeInteger(value.pid)&&value.pid>0&&value.pid<=2147483647&&integer(value.startTicks),'unproven_marker');
   need(value.uid===uid&&value.gid===gid&&value.stateDirectory===stateDirectory&&value.stateDev===String(directoryIdentity.dev)&&value.stateIno===String(directoryIdentity.ino)&&uuid(value.bootId)&&typeof value.pidNamespaceDev==='string'&&/^[0-9]+$/.test(value.pidNamespaceDev)&&integer(value.pidNamespaceIno),'uncertain_owner');
   const previousBoot=value.bootId!==host.bootId;
   need(previousBoot||value.pidNamespaceDev===host.pidNamespaceDev&&value.pidNamespaceIno===host.pidNamespaceIno,'uncertain_owner');
   // In the same boot/namespace, occupied PIDs (including PID reuse and
   // zombies) remain blocked. Different-boot recovery relies on held flock,
   // not on comparing a historical PID against an unrelated current process.
   need(previousBoot||await processStart(value.pid)===null,'owner_present_or_pid_reused');
   await guardCurrent();const current=await readMarker();need(same(existing.identity,current.identity)&&existing.bytes.equals(current.bytes),'marker_changed');
   need(previousBoot||await processStart(value.pid)===null,'owner_present_or_pid_reused');
   let archive;
   if(previousBoot){
    // A reboot releases flock, but can reuse both PIDs and namespace inodes.
    // Preserve the old marker durably before removing its name. Never replace
    // the permanent guard or overwrite a previous recovery artifact.
    archive='real-daily.launcher.stale-'+value.bootId+'-'+randomUUID()+'.json';
    const copy=await open(join(stateDirectory,archive),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await copy.writeFile(existing.bytes);await copy.sync();}finally{await copy.close();}
    const directory=await open(stateDirectory,constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}
    await guardCurrent();const retained=await readMarker();need(same(existing.identity,retained.identity)&&existing.bytes.equals(retained.bytes),'marker_changed');
   }
   await unlink(path);recovered={pid:value.pid,startTicks:value.startTicks,nonce:value.nonce,...(archive?{reason:'previous-boot',archive}:{})};
  }
  await guardCurrent();
  // Do not retry unlink if an unguarded legacy launcher wins this O_EXCL race.
  marker=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  markerIdentity=await marker.stat({bigint:true});regular(markerIdentity,uid,gid,4096);
  const value={schemaVersion:'daily-launcher-lock:2.0.0',familyId:'native-daily',candidateId,stateDirectory,stateDev:String(directoryIdentity.dev),stateIno:String(directoryIdentity.ino),uid,gid,bootId:host.bootId,pidNamespaceDev:host.pidNamespaceDev,pidNamespaceIno:host.pidNamespaceIno,pid:process.pid,startTicks:host.startTicks,nonce:randomUUID()};
  await marker.writeFile(JSON.stringify(value)+'\n');await marker.sync();markerIdentity=await marker.stat({bigint:true});
  const directory=await open(stateDirectory,constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}
  return {recovered,release(){
   if(!releasePromise)releasePromise=(async()=>{
    try{await guardCurrent();const named=await lstat(path,{bigint:true});regular(named,uid,gid,4096);need(same(markerIdentity,named)&&same(markerIdentity,await marker.stat({bigint:true})),'marker_changed');await unlink(path);}
    finally{try{await marker.close();}finally{await guard.close();}}
   })();return releasePromise;
  }};
 }catch(error){
  // Acquisition failure never removes an inspected marker. Even our own
  // incomplete newly-created marker is left for explicit offline recovery.
  try{await marker?.close();}finally{await guard?.close();}throw error;
 }
}
