import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {canonicalNativePath} from '../src/c72-native-configuration.ts';

// Execute the exact production readers with real filesystem descriptors. Only
// the read/canonical-call seams inject deterministic atomic publications.
const source=fs.readFileSync(process.env.CT_PUBLISHED_FILE_SOURCE??new URL('../src/c72-native-configuration.ts',import.meta.url),'utf8');
const start=source.indexOf('const publicationChanges='),end=source.indexOf('/** Engine CID');
assert.ok(start>=0&&end>start);
const selected=stripTypeScriptTypes(source.slice(start,end),{mode:'strip'}).replaceAll('export function','function');
function fixture(t,fault){
 const root=fs.mkdtempSync(join(tmpdir(),'native-published-file-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=join(root,'evidence');fs.mkdirSync(directory,{mode:0o700});
 const path=join(directory,'native-custody.json');fs.writeFileSync(path,'{"sequence":1}',{mode:0o600});
 let opens=0,fileChecks=0,reads=0,published=0,lastReadFd,unlinkedLookup=false;
 const publish=()=>{published++;const next=join(directory,'next');fs.writeFileSync(next,fault==='oversize'?'x'.repeat(8193):fault==='malformed'?'PRIVATE_INVALID_JSON':'{"sequence":2}',{mode:0o600});fs.renameSync(next,path);};
 const deps={dirname,canonicalNativePath:(p,d,owner)=>{
  const stat=canonicalNativePath(p,d,owner);
  if(!d){fileChecks++;if(fault==='beforeOpen'&&published===0||fault==='continuous')publish();}
  return stat;
 },lstatSync:p=>{if(p===path&&unlinkedLookup){unlinkedLookup=false;return fs.fstatSync(lastReadFd);}return fs.lstatSync(p);},openSync:(...args)=>{opens++;return fs.openSync(...args);},closeSync:(fd)=>{fs.closeSync(fd);if(fault==='parentAfterReread'&&opens===2){fs.renameSync(directory,join(root,'prior'));fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(path,'{"sequence":2}',{mode:0o600});}},fstatSync:fs.fstatSync,constants:fs.constants,
 readSync:(...args)=>{reads++;lastReadFd=args[0];const n=fs.readSync(...args);
  if(n>0&&(fault==='unlinkedContinuous'||reads===1&&['unlinkedLookup','unlinkedMissing'].includes(fault))){publish();unlinkedLookup=true;if(fault==='unlinkedMissing')fs.unlinkSync(path);}
  if(reads===1){
   if(['duringRead','oversize','malformed','parentAfterReread'].includes(fault))publish();
   if(fault==='mutate')fs.appendFileSync(path,' ');
   if(fault==='parent'){fs.renameSync(directory,join(root,'prior'));fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(path,'{"sequence":2}',{mode:0o600});}
   if(fault==='symlink'){fs.unlinkSync(path);const other=join(root,'other');fs.writeFileSync(other,'{"sequence":2}',{mode:0o600});fs.symlinkSync(other,path);}
   if(fault==='permissions'){publish();fs.chmodSync(path,0o644);}
   if(fault==='hardlink'){publish();fs.linkSync(path,join(root,'extra-link'));}
  }
  return n;
 },fail:()=>{throw Error('Closed CT native configuration unavailable');}};
 const readers=compileFunction(selected+'\nreturn {readNativeFile,readNativePublishedFile};',Object.keys(deps))(...Object.values(deps));
 return {...readers,path,counts:()=>({opens,fileChecks,published})};
}
test('strict source/configuration reads still refuse an atomic pathname replacement',t=>{
 const f=fixture(t,'duringRead');assert.throws(()=>f.readNativeFile(f.path,8192,true),/unavailable/);assert.equal(f.counts().opens,1);
});
for(const fault of ['beforeOpen','duringRead'])test('published receipt rereads the new path once after '+fault,t=>{
 const f=fixture(t,fault);assert.deepEqual(JSON.parse(f.readNativePublishedFile(f.path,8192,true)),{sequence:2});assert.deepEqual(f.counts(),{opens:2,fileChecks:2,published:1});
});
test('unchanged publication reads once without copying or caching a prior receipt',t=>{
 const f=fixture(t);assert.deepEqual(JSON.parse(f.readNativePublishedFile(f.path,8192,true)),{sequence:1});assert.equal(f.counts().opens,1);
 fs.writeFileSync(f.path,'{"sequence":3}');assert.deepEqual(JSON.parse(f.readNativePublishedFile(f.path,8192,true)),{sequence:3});assert.equal(f.counts().opens,2);
});
test('continuous atomic replacement exhausts exactly two strict attempts; no old descriptor fallback',t=>{
 const f=fixture(t,'continuous');assert.throws(()=>f.readNativePublishedFile(f.path,8192,true),/unavailable/);assert.deepEqual(f.counts(),{opens:2,fileChecks:2,published:2});
});
test('a resolved old unlinked inode is discarded only after a fresh stat confirms a different current inode',t=>{
 const f=fixture(t,'unlinkedLookup');assert.deepEqual(JSON.parse(f.readNativePublishedFile(f.path,8192,true)),{sequence:2});assert.deepEqual(f.counts(),{opens:2,fileChecks:2,published:1});
});
test('an unlinked old lookup with no current path is refused without a second descriptor',t=>{
 const f=fixture(t,'unlinkedMissing');assert.throws(()=>f.readNativePublishedFile(f.path,8192,true),/unavailable/);assert.equal(f.counts().opens,1);
});
test('repeated unlinked lookups still exhaust exactly two full reads and never fall back to old bytes',t=>{
 const f=fixture(t,'unlinkedContinuous');assert.throws(()=>f.readNativePublishedFile(f.path,8192,true),/unavailable/);assert.deepEqual(f.counts(),{opens:2,fileChecks:2,published:2});
});
test('a parent replaced after the second descriptor closes cannot publish that reread',t=>{
 const f=fixture(t,'parentAfterReread');assert.throws(()=>f.readNativePublishedFile(f.path,8192,true),/unavailable/);assert.equal(f.counts().opens,2);
});
for(const fault of ['mutate','parent','symlink','permissions','hardlink','oversize'])test('publication cannot bypass '+fault+' refusal',t=>{
 const f=fixture(t,fault);assert.throws(()=>f.readNativePublishedFile(f.path,8192,true),/unavailable/);assert.equal(f.counts().opens,1,'No second descriptor is opened for an invalid current path or changed parent');
});
test('malformed current JSON is returned only as bytes, then rejected by the original parser without another read',t=>{
 const f=fixture(t,'malformed');assert.throws(()=>JSON.parse(f.readNativePublishedFile(f.path,8192,true)),SyntaxError);assert.deepEqual(f.counts(),{opens:2,fileChecks:2,published:1});
});
test('optional reread diagnostics contain only fixed metadata and reporter failure cannot change the reread',t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs=[];t.mock.method(console,'info',value=>{logs.push(JSON.parse(value));throw Error('PRIVATE_REPORTER');});
 const f=fixture(t,'duringRead');assert.deepEqual(JSON.parse(f.readNativePublishedFile(f.path,8192,true)),{sequence:2});
 assert.deepEqual(logs,[{event:'native-custody-publication-reread',phase:'during-read',maximumReads:2}]);
});
test('failed publication reads retain their original closed category and stage, never arbitrary error text',t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs=[];t.mock.method(console,'info',value=>logs.push(JSON.parse(value)));
 for(const [fault,phase,reason]of [['mutate','first-read','content_changed'],['parent','parent','identity_changed'],['continuous','second-read','publication_before-open'],['parentAfterReread','parent-after-read','identity_changed'],['permissions','second-read','path_unavailable']]){
  logs.length=0;const f=fixture(t,fault);assert.throws(()=>f.readNativePublishedFile(f.path,8192,true));
  const {comparisons,...entry}=logs.at(-1);assert.deepEqual(entry,{event:'native-custody-read-refusal',phase,reason});
  if(fault==='mutate'){assert.ok(comparisons.includes('byte_length')&&comparisons.includes('descriptor.size')&&comparisons.includes('named.size'));assert.ok(comparisons.length<=12);assert.ok(comparisons.every(v=>['byte_length','byte_limit',...['descriptor','named'].flatMap(p=>['dev','ino','size','mtimeMs','ctimeMs'].map(k=>p+'.'+k))].includes(v)));}
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|native-published-file-|sequence/);
 }
});
