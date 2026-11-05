// Original preparation/parser over disposable fixture paths; no engine, entropy,
// pairing secret, actual source installation or approval is invoked here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {observe} from './game-host-fixtures.ts';
const preparation=stripTypeScriptTypes(fs.readFileSync(new URL('../src/native-facts-preparation.ts',import.meta.url),'utf8'));
const configuration=stripTypeScriptTypes(fs.readFileSync(new URL('../src/c72-native-configuration.ts',import.meta.url),'utf8'));
function fixture(t){
 const root=fs.mkdtempSync(join(tmpdir(),'native-grant-inert-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const pin=name=>{const path=join(root,name);fs.writeFileSync(path,'inert '+name,{mode:0o600});return {path,sha256:digest(fs.readFileSync(path))};};
 const wrapper=pin('wrapper'),seccomp=pin('seccomp'),frontend=pin('frontend'),continuation={...pin('continuation'),bytes:18};continuation.bytes=fs.statSync(continuation.path).size;
 const sourcePins=Object.fromEntries(['supervisor','entry','peer','expiry','guiProbe'].map(name=>[name,pin(name)]));
 const imagePins=Object.fromEntries(['mono','rom','core','controller','configFactory'].map(name=>[name,'a'.repeat(64)]));
 const args={C72_IMAGE:'b'.repeat(64),C72_WRAPPER:wrapper.path,C72_SECCOMP:seccomp.path,C72_FRONTEND:frontend.path,C72_STATE:continuation.path,C72_CONTINUATION:{bytes:continuation.bytes,sha256:continuation.sha256},C72_SOURCES:Object.fromEntries(Object.entries(sourcePins).map(([k,v])=>[k,v.path])),C72_KNOWN_PINS:{...imagePins,frontend:frontend.sha256},C72_IMAGE_FILES:imagePins,createHash,join,dirname,isDeepStrictEqual,captureWakePreparation:value=>{assert.equal(value,undefined);return undefined;},...Object.fromEntries(['constants','openSync','closeSync','fstatSync','readSync','lstatSync','realpathSync','readdirSync'].map(k=>[k,fs[k]]))};
 const parserBody=configuration.slice(configuration.search(/export const fileDigest\s*=/),configuration.indexOf('export function c72NativeReadiness(')).replaceAll('export ','');
 const helpers=compileFunction(parserBody+'\nreturn {readNativeFile,canonicalNativePath,fileDigest,scopeDigest,readC72NativeConfiguration};',Object.keys(args))(...Object.values(args));
 Object.assign(args,helpers,...['mkdirSync','readdirSync','writeFileSync','renameSync','existsSync','unlinkSync'].map(k=>({[k]:fs[k]})));
 const make=compileFunction(preparation.replace(/^import .*;$/mg,'').replaceAll('export ','')+'\nreturn createNativeFactsPreparation;',Object.keys(args))(...Object.values(args));
 const template={schemaVersion:'ct-native-template/1',image:args.C72_IMAGE,wrapper,seccomp,frontend,continuation,sources:Object.fromEntries(Object.entries(sourcePins).map(([k,v])=>[k,v.sha256])),imagePins,romSha1:'c'.repeat(40),qualificationRef:'inert-explicit-review'};
 const templateFile=join(root,'template.json');fs.writeFileSync(templateFile,JSON.stringify(template),{mode:0o600});
 const scope=observe().scope,pins='d'.repeat(64),stateRoot=join(root,'ct-native-supervised-INERT');
 const config={templateFile,templateSha256:digest(fs.readFileSync(templateFile)),stateRoot};
 const file=join(stateRoot,'facts',scope.runId+'.json');
 return {make,config,file,scope,pins,root};
}
for(const maximum of [undefined,120000,300000])test(`fresh native preparation ${maximum??'default'} issues exact immutable expiry and pairing identity`,t=>{
 const f=fixture(t),wall=1000000;t.mock.method(Date,'now',()=>wall);
 const config={...f.config,...(maximum===undefined?{}:{maximumNativeLifetimeMs:maximum})};
 const prepared=f.make(config,f.scope,f.pins,f.file).prepare();
 assert.equal(Date.parse(prepared.expiresAt),wall+(maximum??120000));assert.equal(prepared.pairing.expiresAt,prepared.expiresAt);assert.equal(prepared.scope.runId,f.scope.runId);
 assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).expiresAt,prepared.expiresAt);
});
test('invalid requested authority refuses before filesystem preparation; observation cannot add gameplay lifetime',t=>{
 const f=fixture(t);
 for(const maximumNativeLifetimeMs of [0,-1,300001,1.5,'300000',null,undefined,Infinity,true])assert.throws(()=>f.make({...f.config,maximumNativeLifetimeMs},f.scope,f.pins,f.file));
 assert.equal(fs.existsSync(f.config.stateRoot),false);
 const stateRoot=join(f.root,'ct-native-observation-INERT');assert.throws(()=>f.make({...f.config,stateRoot,purpose:'nativeObservationOnly',maximumRunMs:90000,maximumNativeLifetimeMs:300000},f.scope,f.pins,join(stateRoot,'observation-facts',f.scope.runId+'.json')));
});
