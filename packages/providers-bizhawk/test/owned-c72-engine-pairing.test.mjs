// Original server approval/take + original provider facts/pairing, synthetic files only.
import test from 'node:test';import assert from 'node:assert/strict';
import * as fs from 'node:fs';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';import {compileFunction} from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import {isDeepStrictEqual} from 'node:util';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
const entry=process.env.CT_CID_ENTRY??'source';if(!['source','compiled'].includes(entry))throw Error('Unknown test entry');const pathFor=name=>new URL('../'+(entry==='compiled'?'dist/':'src/')+name+(entry==='compiled'?'.js':'.ts'),import.meta.url);
const {createRunScopedNativePairing}=await import(pathFor('native-pairing-custody'));
const {c72NativePlan,C72_IMAGE,scopeDigest,fileDigest}=await import(pathFor('c72-native-configuration'));
const CID='c'.repeat(64),OTHER='d'.repeat(64),PIN='a'.repeat(64),NONCE='e'.repeat(32);
const config=stripTypeScriptTypes(fs.readFileSync(pathFor('c72-native-configuration'),'utf8'));
const approval=stripTypeScriptTypes(fs.readFileSync(new URL('../../../apps/server/src/runtime/ubuntu-native-approval.ts',import.meta.url),'utf8'));
function fixture(t,{lifetimeMs=110000}={}){
 const root=fs.mkdtempSync(join(tmpdir(),'ct74-pairing-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:randomUUID(),environmentId:randomUUID(),activityId:randomUUID(),runId:randomUUID(),activityEpoch:1,timelineId:randomUUID(),timelineRevision:1,campaignId:randomUUID(),observationDomain:'simulatedGame',contextBinding:{conversationId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID(),participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef:'synthetic-only'}};
 const run=join(root,scope.runId);fs.mkdirSync(run,{mode:0o700});for(const name of ['frames','evidence'])fs.mkdirSync(join(run,name),{mode:0o700});
 const pin=name=>{const path=join(root,name);fs.writeFileSync(path,'synthetic-'+name,{mode:0o600});return {path,sha256:fileDigest(fs.readFileSync(path))};};
 const wrapper=pin('wrapper'),seccomp=pin('seccomp'),frontend=pin('frontend'),continuation={...pin('continuation'),bytes:fs.statSync(join(root,'continuation')).size},sources=Object.fromEntries(['supervisor','entry','peer','expiry','guiProbe'].map(k=>[k,pin(k)]));
 const imagePins=Object.fromEntries(['mono','configFactory','rom','core','controller'].map(k=>[k,PIN]));
 const constants={C72_IMAGE,C72_WRAPPER:wrapper.path,C72_SECCOMP:seccomp.path,C72_FRONTEND:frontend.path,C72_STATE:continuation.path,C72_SOURCES:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,v.path])),C72_IMAGE_FILES:imagePins,C72_KNOWN_PINS:{...imagePins,frontend:frontend.sha256},C72_CONTINUATION:{bytes:continuation.bytes,sha256:continuation.sha256}};
 // Actual closed parser and FD helpers, with ONLY immutable installation paths/pins mapped to fixture files.
 const body=config.slice(config.search(/export const fileDigest\s*=/),config.indexOf('export function c72NativeReadiness(')).replaceAll('export ','');
 const args={...constants,createHash,join,dirname,isDeepStrictEqual,...Object.fromEntries(['constants','openSync','closeSync','fstatSync','readSync','lstatSync','realpathSync','readdirSync'].map(k=>[k,fs[k]])),captureWakePreparation:value=>{assert.equal(value,undefined);}};
 const readConfig=compileFunction(body+'return readC72NativeConfiguration;',Object.keys(args))(...Object.values(args));
 const expiresAt=new Date(Date.now()+lifetimeMs).toISOString(),value={schemaVersion:'ct-native-c72/1',image:C72_IMAGE,wrapper,seccomp,frontend,continuation,sources,imagePins,runDirectory:run,scope,pinsDigest:PIN,pairing:{scopeDigest:scopeDigest(scope),pinsDigest:PIN,expiresAt,approvalRef:'synthetic-pairing'},expiresAt,approvalRef:'synthetic-native',romSha1:'b'.repeat(40)},configurationFile=join(root,'facts.json');fs.writeFileSync(configurationFile,JSON.stringify(value),{mode:0o600});
 class GameHostError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
 const make=compileFunction(approval.replace(/^import .*;$/mg,'').replace('export function','function')+'\nreturn createUbuntuNativeApproval;',['createHash','canonicalJson','randomUUID','randomBytes','isDeepStrictEqual','readC72NativeConfiguration','c72NativePlan','scopeDigest','createRunScopedNativePairing','GameHostError'])(createHash,canonicalJson,randomUUID,()=>{throw Error('No unreviewed entropy');},isDeepStrictEqual,readConfig,c72NativePlan,scopeDigest,createRunScopedNativePairing,GameHostError);
 let entropy=0;const native=make({scope,pinsDigest:PIN,configurationFile,...(lifetimeMs>120000?{maximumNativeLifetimeMs:lifetimeMs}:{}),startCurrent:()=>true},{entropy:n=>{entropy++;return Buffer.alloc(n,7);}});t.after(()=>native.close());
 const actor={principalId:scope.principalId,actorId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>true},context={assertCurrent:()=>{}};
 const review=native.review(actor,context);native.approve(actor,{requestId:review.requestId,expectedRevision:review.revision,confirmationDigest:review.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true},context);
 fs.writeFileSync(join(run,'consumed.json'),JSON.stringify({nonce:NONCE,scopeDigest:scopeDigest(scope),pinsDigest:PIN}),{mode:0o600});fs.writeFileSync(join(run,'engine.cid'),CID,{mode:0o644});fs.chmodSync(join(run,'engine.cid'),0o644);fs.writeFileSync(join(run,'owned.cid'),CID,{mode:0o600});
 return {run,native,entropy:()=>entropy,take:()=>native.take({scope,pinsDigest:PIN,approvalRef:value.pairing.approvalRef,expiresAt,invocationNonce:NONCE,signal:new AbortController().signal})};
}
test('original approved server take accepts raw0644 + canonical0600 exact inventory and transfers actual one-use pairing',async t=>{const f=fixture(t),secret=await f.take();assert.equal(secret.length,32);assert.equal(f.entropy(),1);secret.fill(0);await assert.rejects(f.take());assert.equal(f.entropy(),1);});
for(const [name,change] of [
 ['missing engine',run=>fs.unlinkSync(join(run,'engine.cid'))],['missing canonical',run=>fs.unlinkSync(join(run,'owned.cid'))],['CID mismatch',run=>fs.writeFileSync(join(run,'engine.cid'),OTHER)],['highbit raw',run=>fs.writeFileSync(join(run,'engine.cid'),Buffer.alloc(64,0xe3))],['unknown leaf',run=>fs.writeFileSync(join(run,'extra'),'x',{mode:0o600})],['nonprivate canonical',run=>fs.chmodSync(join(run,'owned.cid'),0o644)],['writable raw',run=>fs.chmodSync(join(run,'engine.cid'),0o666)],['symlink raw',run=>{fs.unlinkSync(join(run,'engine.cid'));fs.symlinkSync(join(run,'owned.cid'),join(run,'engine.cid'));}],['partial raw',run=>fs.writeFileSync(join(run,'engine.cid'),'partial')]
])test('original approval/take denies '+name+' before entropy',async t=>{const f=fixture(t);change(f.run);await assert.rejects(f.take());assert.equal(f.entropy(),0);});

test('fresh explicitly reviewed five-minute pairing is still one-use and exact-deadline bound',async t=>{const f=fixture(t,{lifetimeMs:300000}),secret=await f.take();assert.equal(secret.length,32);secret.fill(0);await assert.rejects(f.take());assert.equal(f.entropy(),1);});
test('out-of-range fresh pairing/facts refuse before approval or entropy',t=>{assert.throws(()=>fixture(t,{lifetimeMs:300001}));});
