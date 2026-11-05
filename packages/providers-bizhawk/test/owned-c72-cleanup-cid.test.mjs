// Actual selected cleanup declaration, real disposable private markers, inert process ports.
// No container engine, native host, model or production paths are invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,chmodSync,writeFileSync,readFileSync,lstatSync,unlinkSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readNativeFile,readCreatedEngineCid} from '../src/c72-native-configuration.ts';

const source=stripTypeScriptTypes(readFileSync(new URL('../src/owned-c72-native.ts',import.meta.url),'utf8'));
const readStart=source.indexOf(' const readCid='),readEnd=source.indexOf('\n const readEngineCid=',readStart);
const start=source.indexOf(' const cleanup='),end=source.indexOf('\n const close=',start);
assert(readStart>=0&&readEnd>readStart&&start>=0&&end>start,'Exercise actual selected readCid and cleanup declarations.');
const leftStart=source.indexOf(' const cleanupLeft='),leftEnd=source.indexOf('let lastAction',leftStart);assert(leftStart>=0&&leftEnd>leftStart);
const CID='c'.repeat(64),OTHER='d'.repeat(64),digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,{afterRemove=()=>{},failRemove=false,knownCid=true,initialMode=0o600}={}){
 const directory=mkdtempSync(join(tmpdir(),'ct72-cleanup-'));chmodSync(directory,0o700);t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const marker=join(directory,'owned.cid');writeFileSync(marker,CID+'\n',{mode:initialMode,flag:'wx'});chmodSync(marker,initialMode);
 const engine=join(directory,'engine.cid');writeFileSync(engine,CID,{mode:0o644});const readEngineCid=()=>readCreatedEngineCid(engine,directory);
 const calls=[];
 const inspect=async selected=>{assert.equal(selected,CID);calls.push(['inspect',selected]);};
 const execute=async(args,timeout)=>{
  calls.push([args,timeout]);assert.deepEqual(args,args[0]==='stop'?['stop','--time','15',CID]:['rm',CID]);
  if(args[0]==='rm'){if(failRemove){afterRemove(marker,directory);throw Error('synthetic exact rm failed');}afterRemove(marker,directory);}return '';
 };
 const body=`let createAttempted=true,cid=initialCid,verifiedRunning=true,termination=null,cleanupDeadline=60000;\n${source.slice(leftStart,leftEnd)}\n${source.slice(readStart,readEnd)}\n${source.slice(start,end)}\nreturn {cleanup,state:()=>({cid,verifiedRunning,termination})};`;
 const owner=compileFunction(body,['readNativeFile','plan','cidPattern','inspect','execute','unlinkSync','lstatSync','scopeDigest','scope','pins','nonce','fileDigest','initialCid','readEngineCid','performance','timing'])(readNativeFile,{cidfile:marker,engineCidfile:engine},/^[a-f0-9]{64}$/,inspect,execute,unlinkSync,lstatSync,()=> 'synthetic-scope',{},'synthetic-pins','synthetic-invocation',digest,knownCid?CID:undefined,readEngineCid,{now:()=>0},{inspectionTimeoutMs:15000});
 return {owner,marker,directory,calls};
}
function removed(f){assert.equal(f.owner.state().cid,undefined);assert.equal(f.owner.state().verifiedRunning,false);assert.equal(f.owner.state().termination.removed,true);assert.equal(f.owner.state().termination.containerIdDigest,digest(Buffer.from(CID)));assert.throws(()=>lstatSync(f.marker),{code:'ENOENT'});assert.deepEqual(f.calls,[['inspect',CID],[['stop','--time','15',CID],20000],['inspect',CID],[['rm',CID],15000]]);}
test('successful exact rm may auto-remove private CID marker (Podman)',async t=>{const f=fixture(t,{afterRemove:marker=>unlinkSync(marker)});await f.owner.cleanup();removed(f);});
test('successful exact rm may retain unchanged CID marker (Docker)',async t=>{const f=fixture(t);await f.owner.cleanup();removed(f);});
test('changed marker after successful rm refuses and preserves replacement',async t=>{const f=fixture(t,{afterRemove:marker=>writeFileSync(marker,OTHER+'\n')});await assert.rejects(f.owner.cleanup(),/marker changed after cleanup/);assert.equal(readFileSync(f.marker,'ascii').trim(),OTHER);assert.equal(f.owner.state().termination,null);});
for(const dangling of [false,true])test(`successful rm refuses ${dangling?'dangling':'existing-target'} symlink marker`,async t=>{
 const f=fixture(t,{afterRemove:(marker,directory)=>{unlinkSync(marker);const target=join(directory,'other.cid');if(!dangling)writeFileSync(target,CID+'\n',{mode:0o600});symlinkSync(target,marker);}});
 await assert.rejects(f.owner.cleanup(),/marker changed after cleanup/);assert.equal(lstatSync(f.marker).isSymbolicLink(),true);assert.equal(f.owner.state().termination,null);
});
for(const removedMarker of [false,true])test(`failed rm never claims removal when marker is ${removedMarker?'absent':'present'}`,async t=>{
 const f=fixture(t,{failRemove:true,afterRemove:marker=>{if(removedMarker)unlinkSync(marker);}});await assert.rejects(f.owner.cleanup(),/synthetic exact rm failed/);assert.equal(f.owner.state().termination,null);assert.equal(f.owner.state().cid,CID);assert.equal(f.owner.state().verifiedRunning,true);assert.equal(f.calls.length,4);
});
test('strict pre-removal mode rejection remains before any container operation',async t=>{const f=fixture(t,{initialMode:0o644});const before=lstatSync(f.marker);await assert.rejects(f.owner.cleanup(),/Exact owned native CID unavailable/);assert.deepEqual(f.calls,[]);assert.equal(f.owner.state().termination,null);assert.equal(lstatSync(f.marker).ino,before.ino);assert.equal(lstatSync(f.marker).mode&0o777,0o644);});
test('missing known marker before cleanup refuses without container operation',async t=>{const f=fixture(t);unlinkSync(f.marker);await assert.rejects(f.owner.cleanup(),/marker lost/);assert.deepEqual(f.calls,[]);assert.equal(f.owner.state().termination,null);});
