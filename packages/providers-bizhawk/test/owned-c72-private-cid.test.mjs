// Real executable fixture children only; no Docker, native host or actual run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify,types} from 'node:util';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {mkdtemp,writeFile,chmod,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readNativeFile} from '../src/c72-native-configuration.ts';
import {nativeProcessTimeoutMs} from '../src/owned-c72-native.ts';

const original=await readFile(new URL('../src/owned-c72-native.ts',import.meta.url),'utf8');
const source=stripTypeScriptTypes(original),start=source.indexOf(' const execute='),end=source.indexOf('\n const current=',start);
assert(start>=0&&end>start,'Exercise the actual selected owner execute declaration.');
const environment=compileFunction(source.slice(source.indexOf('const environment='),source.indexOf('\nconst cidPattern='))+'return environment;')();
const selected=(wrapper,testBoundary)=>compileFunction(source.slice(start,end)+'return execute;',['testBoundary','execFile','promisify','facts','environment','types','nativeProcessTimeoutMs'])(testBoundary,execFile,promisify,{wrapper:{path:wrapper}},environment,types,nativeProcessTimeoutMs);
const run=promisify(execFile),CID='e'.repeat(64);
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'ct72-private-cid-'));await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
 const wrapper=join(directory,'literal wrapper.mjs');
 await writeFile(wrapper,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst [operation,...args]=process.argv.slice(2);\nif(operation==='create'){writeFileSync(args[0],'${CID}\\n',{flag:'wx',mode:0o666});process.stdout.write('${CID}\\n');}\nelse process.stdout.write(JSON.stringify({operation,args,umask:process.umask()}));\n`,{mode:0o700});
 return {directory,wrapper};
}
const identity=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs];
test('real create child privately creates CID under ambient022; strict reader rejects preserved original0644',async t=>{
 const f=await fixture(t),originalMask=process.umask(0o022),old=join(f.directory,'old-immutable.cid'),fresh=join(f.directory,'fresh-private.cid');
 try{
  // Reproduce the old actual producer behavior with a real default-mode child.
  assert.equal((await run(f.wrapper,['create',old],{env:environment()})).stdout.trim(),CID);
  const prior=await lstat(old),oldBytes=await readFile(old);assert.equal(prior.mode&0o777,0o644);assert.throws(()=>readNativeFile(old,128,true));assert.equal(process.umask(),0o022);
  assert.equal((await selected(f.wrapper)(['create',fresh],5000)).trim(),CID);
  assert.equal((await lstat(fresh)).mode&0o777,0o600,'CID must be private at creation, without chmod or relaxed reader.');
  assert.equal(readNativeFile(fresh,128,true).toString('ascii').trim(),CID);assert.equal(process.umask(),0o022,'Creator child must not mutate parent umask.');
  assert.deepEqual(await readFile(old),oldBytes);assert.deepEqual(identity(await lstat(old)),identity(prior));assert.throws(()=>readNativeFile(old,128,true));
 }finally{process.umask(originalMask);}
});
test('non-create commands keep original positional wrapper path and ambient mask',async t=>{
 const f=await fixture(t),originalMask=process.umask(0o022);
 try{assert.deepEqual(JSON.parse(await selected(f.wrapper)(['inspect','literal space','quote"value','$unchanged'],3000)),{operation:'inspect',args:['literal space','quote"value','$unchanged'],umask:0o022});assert.equal(process.umask(),0o022);}finally{process.umask(originalMask);}
});
test('existing test boundary receives unchanged original operation arguments',async()=>{
 const calls=[],args=['create','--cidfile','synthetic-private-marker'];const execute=selected('/not-executed',{exec:async(...input)=>{calls.push(input);return 'synthetic';}});assert.equal(await execute(args,1234),'synthetic');assert.deepEqual(calls,[[args,1234]]);
});
