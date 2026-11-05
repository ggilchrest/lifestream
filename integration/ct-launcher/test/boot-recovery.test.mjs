import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,readdir,lstat,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {acquireLauncherLock} from '../launcher-lock.mjs';

const candidate='inert-launcher-recovery-test';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'launcher-boot-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const marker=join(directory,'real-daily.launcher.lock');
 const initial=await acquireLauncherLock(directory,candidate);
 const bytes=await readFile(marker),value=JSON.parse(bytes);
 await initial.release();
 return {directory,marker,bytes,value};
}

test('different-boot marker is archived byte-exact even when its PID is reused in this boot',async t=>{
 const f=await fixture(t),guard=await lstat(join(f.directory,'real-daily.launcher.guard'));
 f.value.bootId=randomUUID();f.value.pid=process.pid;f.value.pidNamespaceIno='1';
 const old=Buffer.from(JSON.stringify(f.value)+'\n');await writeFile(f.marker,old,{mode:0o600});
 const owner=await acquireLauncherLock(f.directory,candidate);
 try{
  assert.equal(owner.recovered.reason,'previous-boot');
  const archive=join(f.directory,owner.recovered.archive);
  assert.deepEqual(await readFile(archive),old);assert.equal((await lstat(archive)).mode&0o777,0o600);
  const fresh=JSON.parse(await readFile(f.marker));
  assert.notEqual(fresh.bootId,f.value.bootId);assert.equal(fresh.pid,process.pid);
  assert.equal((await lstat(join(f.directory,'real-daily.launcher.guard'))).ino,guard.ino);
  await assert.rejects(acquireLauncherLock(f.directory,candidate),/guard_busy/);
 }finally{await owner.release();}
 assert.equal((await readdir(f.directory)).filter(x=>x.startsWith('real-daily.launcher.stale-')).length,1);
 const next=await acquireLauncherLock(f.directory,candidate);assert.equal(next.recovered,null);await next.release();
});

test('same-boot active PID and reused PID remain protected even with guard available',async t=>{
 const f=await fixture(t);await writeFile(f.marker,f.bytes,{mode:0o600});
 await assert.rejects(acquireLauncherLock(f.directory,candidate),/owner_present_or_pid_reused/);
 assert.deepEqual(await readFile(f.marker),f.bytes);
 f.value.startTicks='1';await writeFile(f.marker,JSON.stringify(f.value),{mode:0o600});
 await assert.rejects(acquireLauncherLock(f.directory,candidate),/owner_present_or_pid_reused/);
 assert.equal((await readdir(f.directory)).some(x=>x.includes('.stale-')),false);
});

test('same-boot different namespace and malformed boot identity fail without archiving',async t=>{
 const f=await fixture(t);f.value.pidNamespaceIno='1';
 await writeFile(f.marker,JSON.stringify(f.value),{mode:0o600});
 await assert.rejects(acquireLauncherLock(f.directory,candidate),/uncertain_owner/);
 f.value.bootId='not-a-boot-id';await writeFile(f.marker,JSON.stringify(f.value),{mode:0o600});
 await assert.rejects(acquireLauncherLock(f.directory,candidate),/uncertain_owner/);
 assert.equal((await readdir(f.directory)).some(x=>x.includes('.stale-')),false);
});

test('kernel guard contention cannot archive an old-boot-looking replacement marker',async t=>{
 const f=await fixture(t),owner=await acquireLauncherLock(f.directory,candidate);
 const original=await readFile(f.marker);f.value.bootId=randomUUID();
 await writeFile(f.marker,JSON.stringify(f.value));
 await assert.rejects(acquireLauncherLock(f.directory,candidate),/guard_busy/);
 assert.equal((await readdir(f.directory)).some(x=>x.includes('.stale-')),false);
 // Replacement deliberately violated custody; release must refuse its unlink.
 await assert.rejects(owner.release(),/marker_changed/);
 assert.notDeepEqual(await readFile(f.marker),original);
});

test('symlink marker is refused without touching its target',async t=>{
 const f=await fixture(t),target=join(f.directory,'unrelated');await writeFile(target,'keep',{mode:0o600});
 await symlink(target,f.marker);await assert.rejects(acquireLauncherLock(f.directory,candidate),/unsafe_file/);
 assert.equal(await readFile(target,'utf8'),'keep');
});

test('same-boot absent process recovery remains available',async t=>{
 const f=await fixture(t);f.value.pid=2147483647;
 await writeFile(f.marker,JSON.stringify(f.value),{mode:0o600});
 const owner=await acquireLauncherLock(f.directory,candidate);
 assert.equal(owner.recovered.pid,2147483647);assert.equal(owner.recovered.archive,undefined);await owner.release();
});

test('different boot does not excuse a marker bound to another state inode',async t=>{
 const f=await fixture(t);f.value.bootId=randomUUID();f.value.stateIno='1';
 const old=JSON.stringify(f.value);await writeFile(f.marker,old,{mode:0o600});
 await assert.rejects(acquireLauncherLock(f.directory,candidate),/uncertain_owner/);
 assert.equal(await readFile(f.marker,'utf8'),old);
});

test('old-boot launcher recovery preserves consumed CT claims and grant fixtures',async t=>{
 const f=await fixture(t),job=join(f.directory,'inert-ct-job');await mkdir(job,{mode:0o700});
 const files=['REGISTRATION-CLAIM.json','OWNER-CLAIM.json','CONSUMED-start.json','grant.json'];
 for(const name of files)await writeFile(join(job,name),JSON.stringify({inert:true,consumed:true,nonce:'fixture-'+name}),{mode:0o400});
 const before=await Promise.all(files.map(name=>readFile(join(job,name))));
 f.value.bootId=randomUUID();await writeFile(f.marker,JSON.stringify(f.value),{mode:0o600});
 const owner=await acquireLauncherLock(f.directory,candidate);await owner.release();
 assert.deepEqual(await Promise.all(files.map(name=>readFile(join(job,name)))),before);
 assert.deepEqual((await readdir(job)).sort(),files.sort());
});

test('actual launcher completion handler reports consumed CT as a NOJOB recovery requirement',async()=>{
 // Evaluate only the original completion callback, never the operational launcher.
 const source=await readFile(new URL('../start-canonical.mjs',import.meta.url),'utf8');
 const match=/ctJob\.completion\.then\((result=>\{[^\n]+?\}),\(\)=>/.exec(source);assert(match);
 const events=[];let closed=0;
 const finish=runInNewContext('('+match[1]+')',{closeCtArchive:()=>closed++,emit:value=>events.push(JSON.parse(JSON.stringify(value)))});
 finish({status:'CONSUMED_NO_RETRY'});
 assert.equal(closed,1);assert.deepEqual(events,[{event:'dedicated-ct-job-refused',code:'ct_job_consumed_no_retry',recoveryRequired:'NOJOB',modelActionProven:false}]);
 events.length=0;finish(undefined);assert.equal(events[0].event,'dedicated-ct-job-settled');assert.equal(events[0].modelActionProven,false);
});
