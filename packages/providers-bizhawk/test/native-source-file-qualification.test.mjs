// Exact candidate method with controlled filesystem boundaries; only temp public bytes.
import test from 'node:test';import assert from 'node:assert/strict';
import * as fs from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';import {compileFunction} from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../src/native-evidence.ts',import.meta.url),'utf8');
const start=source.indexOf(' private filesCurrent('),end=source.indexOf(' private ownedScope(',start);
assert(start>0&&end>start);
const identity=source.split('\n').filter(x=>x.startsWith('const sourceIdentity=')||x.startsWith('const sameSourceIdentity=')).join('\n');
const method=stripTypeScriptTypes(identity+'\n'+source.slice(start,end).replace(' private filesCurrent(','function filesCurrent('),{mode:'strip'});
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,overrides={}){
 const root=fs.mkdtempSync(join(tmpdir(),'native-source-proof-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const path=join(root,'source'),bytes=Buffer.from('original public fixture bytes');fs.writeFileSync(path,bytes,{mode:0o400});
 const counts={opens:0,closes:0,reads:0,hashes:0},active=new Set();
 const deps={lstatSync(...args){const s=fs.lstatSync(...args);return overrides.stat?.(s)??s;},realpathSync:fs.realpathSync,fstatSync(...args){const s=fs.fstatSync(...args);return overrides.stat?.(s)??s;},constants:fs.constants,
  openSync(...args){counts.opens++;assert(args[1]&fs.constants.O_NOFOLLOW);assert(args[1]&fs.constants.O_NONBLOCK);const fd=fs.openSync(...args);active.add(fd);overrides.afterOpen?.({path,fd,root});return fd;},
  closeSync(fd){counts.closes++;active.delete(fd);return fs.closeSync(fd);},
  readSync(...args){counts.reads++;const n=fs.readSync(...args);overrides.afterRead?.({path,fd:args[0],root,n});return n;},
  createHash(...args){counts.hashes++;return createHash(...args);},captureNativeSource:(sink,v)=>sink?.(v),nativeSourceException:()=> 'Error',Buffer};
 const check=compileFunction(method+'\nreturn filesCurrent;',Object.keys(deps))(...Object.values(deps));
 const owner={options:{sourceFiles:[{path,sha256:overrides.expected??sha(bytes)}]},sourceQualifications:new Map()};
 const run=()=>{const events=[];const result=check.call(owner,v=>events.push(v));assert.equal(active.size,0);assert.equal(counts.opens,counts.closes);return {result,events};};
 t.after(()=>{assert.equal(active.size,0);assert.equal(counts.opens,counts.closes);});
 return {path,root,bytes,counts,owner,run};
}
test('130 unchanged qualifications hash once, but open and close a freshly checked FD every use',t=>{
 const f=fixture(t);for(let i=0;i<130;i++)assert.equal(f.run().result,true);
 assert.equal(f.counts.hashes,1);assert.equal(f.counts.opens,130);assert.equal(f.owner.sourceQualifications.size,1);
});
test('wrong expected hash never creates a positive proof',t=>{const f=fixture(t,{expected:'0'.repeat(64)});assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);assert.equal(f.run().result,false);assert.equal(f.counts.hashes,2);});
test('same-size in-place rewrite with restored mtime is denied by fresh ctime/hash',t=>{
 const f=fixture(t);assert.equal(f.run().result,true);const stat=fs.statSync(f.path);fs.chmodSync(f.path,0o600);fs.writeFileSync(f.path,Buffer.alloc(f.bytes.length,120));fs.utimesSync(f.path,stat.atime,stat.mtime);
 assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);
 fs.writeFileSync(f.path,f.bytes);assert.equal(f.run().result,true);assert.equal(f.counts.hashes,3);
});
test('wrong replacement inode is denied even at equal size and restored mtime',t=>{
 const f=fixture(t);assert.equal(f.run().result,true);const stat=fs.statSync(f.path),replacement=join(f.root,'replacement');fs.writeFileSync(replacement,Buffer.alloc(f.bytes.length,121),{mode:0o400});fs.utimesSync(replacement,stat.atime,stat.mtime);fs.renameSync(replacement,f.path);assert.equal(f.run().result,false);
});
test('correct replacement inode requires a fresh hash before acceptance',t=>{
 const f=fixture(t);assert.equal(f.run().result,true);const replacement=join(f.root,'replacement');fs.writeFileSync(replacement,f.bytes,{mode:0o400});fs.renameSync(replacement,f.path);assert.equal(f.run().result,true);assert.equal(f.counts.hashes,2);
});
test('symlink replacement is refused before open',t=>{const f=fixture(t);assert.equal(f.run().result,true);const original=join(f.root,'original');fs.renameSync(f.path,original);fs.symlinkSync(original,f.path);assert.equal(f.run().result,false);assert.equal(f.counts.opens,1);assert.equal(f.owner.sourceQualifications.size,0);});
test('mode or link-count changes invalidate proof and require fresh correct hash',t=>{
 const f=fixture(t);assert.equal(f.run().result,true);fs.chmodSync(f.path,0o600);assert.equal(f.run().result,true);assert.equal(f.counts.hashes,2);fs.linkSync(f.path,join(f.root,'hardlink'));assert.equal(f.run().result,true);assert.equal(f.counts.hashes,3);
});
test('same-FD/named identity race after opening is denied and FD closed',t=>{
 let armed=false;const f=fixture(t,{afterOpen({path,root}){if(!armed)return;armed=false;const p=join(root,'replacement');fs.writeFileSync(p,Buffer.alloc(f.bytes.length,120));fs.renameSync(p,path);}});assert.equal(f.run().result,true);armed=true;assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);
});
test('in-place rewrite during read is denied even if bytes already read matched',t=>{
 let armed=true;const f=fixture(t,{afterRead({path,n}){if(armed&&n){armed=false;fs.chmodSync(path,0o600);fs.writeFileSync(path,Buffer.alloc(f.bytes.length,120));}}});assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);
});
test('shrink during read cannot earn a partial-hash proof',t=>{let armed=true;const f=fixture(t,{afterRead({path,n}){if(armed&&n){armed=false;fs.chmodSync(path,0o600);fs.truncateSync(path,1);}}});assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);});
test('growth during read is bounded and refused',t=>{let armed=true;const f=fixture(t,{afterRead({path,n}){if(armed&&n){armed=false;fs.chmodSync(path,0o600);fs.appendFileSync(path,Buffer.alloc(100));}}});assert.equal(f.run().result,false);assert(f.counts.reads<=2);assert.equal(f.owner.sourceQualifications.size,0);});
test('directory replacement is refused without retaining old proof',t=>{const f=fixture(t);assert.equal(f.run().result,true);fs.unlinkSync(f.path);fs.mkdirSync(f.path);assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);});
test('removed source is refused without retaining old proof',t=>{const f=fixture(t);assert.equal(f.run().result,true);fs.unlinkSync(f.path);assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);});
test('empty pinned source still requires EOF and the correct digest',t=>{const f=fixture(t);fs.chmodSync(f.path,0o600);fs.writeFileSync(f.path,'');f.owner.options.sourceFiles[0].sha256=sha('');assert.equal(f.run().result,true);assert.equal(f.counts.reads,1);assert.equal(f.run().result,true);assert.equal(f.counts.hashes,1);});
test('qualification changes do not memoize other sourceFiles or owner instances',t=>{
 const a=fixture(t),b=fixture(t);assert.equal(a.run().result,true);assert.equal(b.run().result,true);assert.equal(a.counts.hashes,1);assert.equal(b.counts.hashes,1);
 const second=join(a.root,'second');fs.writeFileSync(second,'second');a.owner.options.sourceFiles.push({path:second,sha256:sha('second')});assert.equal(a.run().result,true);fs.writeFileSync(second,'wrong!');assert.equal(a.run().result,false);assert(a.owner.sourceQualifications.has(a.path));
});
for(const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'])test('fresh '+key+' change cannot reuse the preceding positive FD proof',t=>{
 let changed=false;const f=fixture(t,{stat(s){if(!changed)return s;return Object.assign(Object.create(Object.getPrototypeOf(s)),s,{[key]:s[key]+1n});}});
 assert.equal(f.run().result,true);changed=true;const next=f.run();assert.equal(f.counts.hashes,2,'Changed metadata requires content requalification');assert.equal(next.result,key!=='size');
});
test('read exception invalidates proof and closes the exact descriptor',t=>{const f=fixture(t,{afterRead(){throw new TypeError('inert read failure');}});assert.equal(f.run().result,false);assert.equal(f.owner.sourceQualifications.size,0);assert.equal(f.counts.opens,1);assert.equal(f.counts.closes,1);});
