import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,lstatSync,rmSync,openSync,closeSync,fstatSync,constants,renameSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {beginNativeRefreshTiming,createNativeInspectionTiming,captureNativeRefreshTiming} from '../src/native-refresh-timing.ts';
import {canonicalNativePath} from '../src/c72-native-configuration.ts';

const source=readFileSync(new URL('../src/owned-c72-native.ts',import.meta.url),'utf8');
const begin=source.indexOf(' const captureRefreshTimeout='),end=source.indexOf(' const installedSources=',begin);
assert(begin>=0&&end>begin);
const body=stripTypeScriptTypes('let refreshTimeoutCaptured=false;'+source.slice(begin,end),{mode:'strip'})+'\nreturn captureRefreshTimeout;';
function fixture(t){
 const runDirectory=mkdtempSync(join(tmpdir(),'refresh-private-custody-'));mkdirSync(join(runDirectory,'evidence'),{mode:0o700});t.after(()=>rmSync(runDirectory,{recursive:true,force:true}));
 const scope={runId:'synthetic-private-timeout'},pins='a'.repeat(64),facts={runDirectory,expiresAt:new Date(Date.now()+15000).toISOString()},expiresMono=performance.now()+15000;
 const scopeDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),inspectionTiming=createNativeInspectionTiming();
 const refreshEvidenceDirectory=join(runDirectory,'evidence'),refreshEvidenceIdentity=canonicalNativePath(refreshEvidenceDirectory,true,true),runIdentity=canonicalNativePath(runDirectory,true,true);
 const descriptors=new Set();let onOpen=()=>{};
 const controlledOpen=(...args)=>{onOpen(...args);const fd=openSync(...args);descriptors.add(fd);return fd;};
 const controlledClose=fd=>{try{closeSync(fd);}finally{descriptors.delete(fd);}};
 t.after(()=>assert.equal(descriptors.size,0,'Every successful and refused diagnostic closes its own descriptors'));
 const ports={scopeDigest,scope,pins,facts,expiresMono,inspectionTiming,writeFileSync,join,captureNativeRefreshTiming,refreshEvidenceDirectory,refreshEvidenceIdentity,runIdentity,canonicalNativePath,openSync:controlledOpen,closeSync:controlledClose,fstatSync,lstatSync,constants};
 const capture=compileFunction(body,Object.keys(ports))(...Object.values(ports));
 return {capture,path:join(runDirectory,'evidence/native-refresh-timeout.json'),facts,inspectionTiming,refreshEvidenceDirectory,onOpen:callback=>{onOpen=callback;}};
}
test('original physical timeout sink retains one private immutable snapshot without renewing native expiry',t=>{
 const f=fixture(t),expiry=f.facts.expiresAt,client=beginNativeRefreshTiming(15000);client.entered();f.inspectionTiming.begin().phase('engine-read');
 f.capture(client.snapshot());const saved=readFileSync(f.path),identity=lstatSync(f.path);
 assert.equal(identity.mode&0o777,0o400);const result=JSON.parse(saved);
 assert.equal(result.schemaVersion,'ct-native-refresh-timeout/1');assert.equal(result.authority,false);assert.equal(result.inspection.phase,'engine-read');assert.equal(result.client.budgetMs,15000);
 assert(result.nativeWallRemainingMs<=15000&&result.nativeMonotonicRemainingMs<=15000);assert.equal(f.facts.expiresAt,expiry);
 client.settled();f.capture(client.snapshot());assert.deepEqual(readFileSync(f.path),saved);assert.equal(lstatSync(f.path).ino,identity.ino);
});
test('parent replacement between directory validation and leaf creation cannot redirect diagnostic data',t=>{
 const f=fixture(t),old=f.refreshEvidenceDirectory+'.original',elsewhere=mkdtempSync(join(tmpdir(),'refresh-private-race-'));t.after(()=>rmSync(elsewhere,{recursive:true,force:true}));
 f.onOpen(path=>{if(String(path).startsWith('/proc/self/fd/')){renameSync(f.refreshEvidenceDirectory,old);symlinkSync(elsewhere,f.refreshEvidenceDirectory);}});
 assert.throws(()=>f.capture(beginNativeRefreshTiming(15000).snapshot()));
 assert(!existsSync(join(elsewhere,'native-refresh-timeout.json')));assert.equal(lstatSync(join(old,'native-refresh-timeout.json')).size,0);
});
test('original physical timeout sink never replaces a pre-existing path',t=>{
 const f=fixture(t);writeFileSync(f.path,'prior evidence',{mode:0o400,flag:'wx'});
 assert.throws(()=>f.capture(beginNativeRefreshTiming(15000).snapshot()),{code:'EEXIST'});
 assert.equal(readFileSync(f.path,'utf8'),'prior evidence');
});
for(const mode of ['symlink','replacement'])test('original physical timeout sink refuses changed '+mode+' parent before writing data',t=>{
 const f=fixture(t),old=f.refreshEvidenceDirectory+'.original',elsewhere=mkdtempSync(join(tmpdir(),'refresh-private-elsewhere-'));t.after(()=>rmSync(elsewhere,{recursive:true,force:true}));
 renameSync(f.refreshEvidenceDirectory,old);
 if(mode==='symlink')symlinkSync(elsewhere,f.refreshEvidenceDirectory);else mkdirSync(f.refreshEvidenceDirectory,{mode:0o700});
 assert.throws(()=>f.capture(beginNativeRefreshTiming(15000).snapshot()));
 assert(!existsSync(f.path));assert(!existsSync(join(elsewhere,'native-refresh-timeout.json')));assert(!existsSync(join(old,'native-refresh-timeout.json')));
});
