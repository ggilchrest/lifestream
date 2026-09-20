import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Database } from '../../../packages/storage-sqlite/src/database.ts';
import { PresentationPackages, PresentationSelection, validatePresentation } from '../src/admin/presentation-packages.ts';
import { createLifestreamServer } from '../src/index.ts';
import { loadProfile } from '../src/config/loader.ts';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'presentation-test-')),directory=join(root,'neutral-test');mkdirSync(directory);
 const model=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Reference'}],scene:0}));writeFileSync(join(directory,'model.gltf'),model);
 const manifest={schemaVersion:'1.0.0',id:'neutral-test',version:'1',label:'Synthetic reference',renderer:'three-glb.v1',model:'model.gltf',resources:[{path:'model.gltf',sha256:createHash('sha256').update(model).digest('hex'),bytes:model.length,mime:'model/gltf+json'}],framing:{distance:1.2,targetHeight:.5},animations:{},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral'};
 writeFileSync(join(root,'index.json'),JSON.stringify(['neutral-test']));const save=()=>writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));save();
 return {root,directory,manifest,save,open:()=>new PresentationPackages({directory:root,ownerPrincipalId:'owner'}),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('presentation resources are owner-only, digest pinned, path bounded, and contain no browser filesystem paths',t=>{
 const f=fixture();t.after(f.close);const packages=f.open();assert.equal(packages.list('owner').length,1);assert.deepEqual(packages.list('other'),[]);assert.doesNotMatch(JSON.stringify(packages.list('owner')),new RegExp(f.root));
 assert.throws(()=>packages.resource('other','neutral-test','model.gltf'));assert.throws(()=>packages.resource('owner','neutral-test','../index.json'));assert.equal(packages.resource('owner','neutral-test','model.gltf').bytes.length,f.manifest.resources[0]!.bytes);
 writeFileSync(join(f.directory,'model.gltf'),'changed');assert.throws(()=>packages.resource('owner','neutral-test','model.gltf'),/changed/);
});
test('presentation rejects script fields, undeclared network references, symlink escapes and oversized resources',t=>{
 const f=fixture();t.after(f.close);
 assert.throws(()=>validatePresentation({...f.manifest,script:'run.js'}));assert.throws(()=>validatePresentation({...f.manifest,resources:[{...f.manifest.resources[0],path:'../outside.glb'}]}));assert.throws(()=>validatePresentation({...f.manifest,resources:[{...f.manifest.resources[0],bytes:193*1024*1024}]}));
 const model=Buffer.from(JSON.stringify({asset:{version:'2.0'},images:[{uri:'https://untrusted.invalid/pixel.png'}]}));writeFileSync(join(f.directory,'model.gltf'),model);f.manifest.resources[0]!.bytes=model.length;f.manifest.resources[0]!.sha256=createHash('sha256').update(model).digest('hex');f.save();assert.deepEqual(f.open().failures,['neutral-test']);
 const outside=join(f.root,'outside.gltf');writeFileSync(outside,model);rmSync(join(f.directory,'model.gltf'));symlinkSync(outside,join(f.directory,'model.gltf'));assert.equal(f.open().list('owner').length,0);
});
test('versioned presentation mappings accept every conversation state and reject unbounded transitions or silent legacy changes',t=>{
 const f=fixture();t.after(f.close);
 const newer={...f.manifest,schemaVersion:'1.1.0',animations:{idle:'rest',preparing:'ready',interrupted:'stop',working:'task',waiting:'wait',failure:'degraded'},transitionSeconds:.3};
 assert.equal(validatePresentation(newer).animations.preparing,'ready');
 assert.throws(()=>validatePresentation({...newer,schemaVersion:'1.0.0'}),/Unsupported/);
 for(const transitionSeconds of [-1,1.01,NaN,Infinity,'fast'])assert.throws(()=>validatePresentation({...newer,transitionSeconds}),/transition/);
 assert.throws(()=>validatePresentation({...newer,animations:{...newer.animations,execute:'script'}}),/Unsupported/);
 assert.equal(validatePresentation(f.manifest).schemaVersion,'1.0.0');
});
test('endpoint defaults and session overrides survive restart, conflict atomically and never cross owners',t=>{
 const f=fixture();t.after(f.close);const path=join(f.root,'state.sqlite');let db=new Database({path});db.migrate();let selections=new PresentationSelection(db);const packages=f.open(),item=packages.list('owner')[0]!;
 selections.select('owner','endpoint','session-a',{scope:'default',id:item.id,digest:item.digest,expectedRevision:0},packages);
 selections.select('owner','endpoint','session-a',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0},packages);
 assert.throws(()=>selections.select('owner','endpoint','session-a',{scope:'default',id:'neutral',digest:'neutral-v1',expectedRevision:0},packages),/conflict/);db.close();db=new Database({path});t.after(()=>db.close());selections=new PresentationSelection(db);
 assert.equal(selections.read('owner','endpoint','session-a').override?.id,'neutral');assert.equal(selections.read('owner','endpoint','session-b').default?.id,'neutral-test');assert.equal(selections.read('owner','endpoint','session-b').override,null);assert.deepEqual(selections.read('other','endpoint','session-a'),{default:null,override:null});
});
test('actual HTTP authentication and CSRF protect private catalog, resources and selection',async t=>{
 const f=fixture();t.after(f.close);const config=loadProfile('test');config.storage={databasePath:join(f.root,'runtime.sqlite'),artifactDirectory:join(f.root,'artifacts')};config.authority.authentication='local-password';const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');const localAuth={stateDirectory:join(f.root,'safety'),installerToken};let app=createLifestreamServer({config,localAuth});await app.start();let base=`http://127.0.0.1:${app.address().port}`,cookie='',csrf='';
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/api/runtime/v1/presentation')).status,401);const setup=await request('/api/auth/v1/setup',{username:'owner',password,installerToken});cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const identity=await setup.json() as {session:{principalId:string;csrfToken:string}};csrf=identity.session.csrfToken;await app.shutdown();
 app=createLifestreamServer({config,localAuth,presentationPackages:{directory:f.root,ownerPrincipalId:identity.session.principalId}});await app.start();t.after(()=>app.shutdown());base=`http://127.0.0.1:${app.address().port}`;
 const signedIn=await request('/api/auth/v1/sign-in',{username:'owner',password});cookie=signedIn.headers.get('set-cookie')!.split(';')[0]!;csrf=(await signedIn.json() as {session:{csrfToken:string}}).session.csrfToken;
 const catalog=await (await request('/api/runtime/v1/presentation')).json() as {packages:{id:string;digest:string}[]};assert.equal(catalog.packages.length,1);assert.equal((await request('/api/runtime/v1/presentation/resources/neutral-test/model.gltf')).status,200);
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'unknown'})).status,200);
 const selection={scope:'default',id:catalog.packages[0]!.id,digest:catalog.packages[0]!.digest,expectedRevision:0};assert.equal((await request('/api/runtime/v1/presentation',selection,{'x-lifestream-csrf':'wrong'})).status,403);assert.equal((await request('/api/runtime/v1/presentation',selection)).status,200);assert.equal((await request('/api/runtime/v1/presentation',selection)).status,409);
 assert.equal((await request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await request('/api/runtime/v1/presentation/resources/neutral-test/model.gltf')).status,401);
 assert.equal(readFileSync(join(f.directory,'model.gltf')).length,f.manifest.resources[0]!.bytes);
});
