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
test('catalog-only hosts retain owner selections without reading or serving resource bytes',t=>{
 const f=fixture();t.after(f.close);
 const open=()=>new PresentationPackages({directory:f.root,ownerPrincipalId:'owner',catalogOnly:true});
 const withBytes=open();assert.equal(withBytes.list('owner').length,1);
 assert.throws(()=>withBytes.resource('owner','neutral-test','model.gltf'),/unavailable/);
 rmSync(join(f.directory,'model.gltf'));
 const catalog=open(),item=catalog.list('owner')[0]!;
 assert.equal(item.id,'neutral-test');assert.deepEqual(catalog.failures,[]);assert.deepEqual(catalog.list('other'),[]);
 assert.equal(catalog.matches('owner',item.id,item.digest),true);assert.equal(catalog.matches('other',item.id,item.digest),false);
 assert.throws(()=>catalog.resource('owner',item.id,'model.gltf'),/unavailable/);
 assert.deepEqual(f.open().failures,['neutral-test']);
 const db=new Database({path:join(f.root,'catalog.sqlite')});db.migrate();t.after(()=>db.close());const selections=new PresentationSelection(db);
 selections.select('owner','endpoint','session',{scope:'default',id:item.id,digest:item.digest,expectedRevision:0},catalog);
 assert.equal(selections.runtimeState('owner','endpoint','session',catalog,true).state,'configuredNotObserved');
 assert.equal(selections.runtimeState('owner','endpoint','session',catalog,false).state,'unavailable');
 f.manifest.resources[0]!.path='../outside.glb';f.save();assert.deepEqual(open().failures,['neutral-test']);
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
 assert.equal(selections.read('owner','endpoint','session-a').override?.id,'neutral');assert.equal(selections.read('owner','endpoint','session-b').default?.id,'neutral-test');assert.equal(selections.read('owner','endpoint','session-b').override,null);assert.deepEqual(selections.read('other','endpoint','session-a'),{default:null,override:null,overrideRevision:0});
});
for(const catalogOnly of [false,true])test(`actual HTTP authentication and CSRF protect private catalog, resources and selection (catalogOnly=${catalogOnly})`,async t=>{
 const f=fixture();t.after(f.close);const config=loadProfile('test');config.storage={databasePath:join(f.root,'runtime.sqlite'),artifactDirectory:join(f.root,'artifacts')};config.authority.authentication='local-password';const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');const localAuth={stateDirectory:join(f.root,'safety'),installerToken};let app=createLifestreamServer({config,localAuth});await app.start();let base=`http://127.0.0.1:${app.address().port}`,cookie='',csrf='';
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/api/runtime/v1/presentation')).status,401);const setup=await request('/api/auth/v1/setup',{username:'owner',password,installerToken});cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const identity=await setup.json() as {session:{principalId:string;csrfToken:string}};csrf=identity.session.csrfToken;await app.shutdown();
 if(catalogOnly)rmSync(join(f.directory,'model.gltf'));
 app=createLifestreamServer({config,localAuth,presentationPackages:{directory:f.root,ownerPrincipalId:identity.session.principalId,catalogOnly}});await app.start();t.after(()=>app.shutdown());base=`http://127.0.0.1:${app.address().port}`;
 const signedIn=await request('/api/auth/v1/sign-in',{username:'owner',password});cookie=signedIn.headers.get('set-cookie')!.split(';')[0]!;csrf=(await signedIn.json() as {session:{csrfToken:string}}).session.csrfToken;
 const catalog=await (await request('/api/runtime/v1/presentation')).json() as {packages:{id:string;digest:string}[]};assert.equal(catalog.packages.length,1);assert.equal((await request('/api/runtime/v1/presentation/resources/neutral-test/model.gltf')).status,catalogOnly?404:200);
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'unknown'})).status,200);
 const selection={scope:'default',id:catalog.packages[0]!.id,digest:catalog.packages[0]!.digest,expectedRevision:0};assert.equal((await request('/api/runtime/v1/presentation',selection,{'x-lifestream-csrf':'wrong'})).status,403);assert.equal((await request('/api/runtime/v1/presentation',selection)).status,200);assert.equal((await request('/api/runtime/v1/presentation',selection)).status,409);
 const override={scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0};assert.equal((await request('/api/runtime/v1/presentation',override)).status,200);const clear={operation:'clearSessionOverride',expectedRevision:1};assert.equal((await request('/api/runtime/v1/presentation',clear,{'x-lifestream-csrf':'wrong'})).status,403);const cleared=await request('/api/runtime/v1/presentation',clear);assert.equal(cleared.status,200);assert.equal((await cleared.json() as {selection:{override:unknown}}).selection.override,null);assert.equal((await request('/api/runtime/v1/presentation',override)).status,409);
 assert.equal((await request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await request('/api/runtime/v1/presentation/resources/neutral-test/model.gltf')).status,401);
 if(!catalogOnly)assert.equal(readFileSync(join(f.directory,'model.gltf')).length,f.manifest.resources[0]!.bytes);
});

test('versioned facial mappings are data-only and bound gaze axes, ownership targets and blink timing',t=>{
 const f=fixture();t.after(f.close);const face={gaze:{nodes:[{node:'Eye',yawAxis:[0,1,0],pitchAxis:[1,0,0]}],yawLimit:.25,pitchLimit:.15},blink:{clip:'closed',periodSeconds:4,durationSeconds:.2}},manifest={...f.manifest,schemaVersion:'1.2.0',face,capabilities:{lipSync:'none',facialAnimation:true}};
 assert.ok(validatePresentation(manifest).face?.gaze);assert.throws(()=>validatePresentation({...manifest,schemaVersion:'1.1.0'}),/Unsupported/);assert.throws(()=>validatePresentation({...manifest,face:{...face,script:'run'}}),/Unsupported/);
 for(const bad of [{...face.gaze,yawLimit:1},{...face.gaze,pitchLimit:NaN},{...face.gaze,nodes:[]},{...face.gaze,nodes:[...face.gaze.nodes,...face.gaze.nodes]},{...face.gaze,nodes:[{node:'Eye',yawAxis:[0,0,0],pitchAxis:[1,0,0]}]}])assert.throws(()=>validatePresentation({...manifest,face:{...face,gaze:bad}}),/gaze/);
 for(const durationSeconds of [0,2,Infinity,'fast'])assert.throws(()=>validatePresentation({...manifest,face:{blink:{...face.blink,durationSeconds}}}),/blink/);
 assert.throws(()=>validatePresentation({...manifest,capabilities:{lipSync:'none',facialAnimation:false}}),/facial/);
});


test('clearing only the current session override preserves the default and monotonic revisions across restart',t=>{
 const f=fixture();t.after(f.close);const path=join(f.root,'clear.sqlite');let db=new Database({path});db.migrate();let selections=new PresentationSelection(db);const packages=f.open(),item=packages.list('owner')[0]!;
 selections.select('owner','endpoint','session-a',{scope:'default',id:item.id,digest:item.digest,expectedRevision:0},packages);
 selections.select('owner','endpoint','session-a',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0},packages);
 const cleared=selections.select('owner','endpoint','session-a',{operation:'clearSessionOverride',expectedRevision:1},packages);assert.equal(cleared.override,null);assert.equal(cleared.overrideRevision,2);assert.equal(cleared.default?.id,item.id);
 assert.throws(()=>selections.select('owner','endpoint','session-a',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0},packages),/conflict/);
 assert.throws(()=>selections.select('owner','endpoint','session-a',{operation:'clearSessionOverride',scope:'default',expectedRevision:2},packages),/Unsupported/);
 db.close();db=new Database({path});t.after(()=>db.close());selections=new PresentationSelection(db);assert.equal(selections.read('owner','endpoint','session-a').overrideRevision,2);
 const updated=selections.select('owner','endpoint','session-a',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:2},packages);assert.equal(updated.override?.revision,3);
 selections.select('owner','endpoint','session-b',{operation:'clearSessionOverride',expectedRevision:0},packages);assert.equal(selections.read('owner','endpoint','session-a').override?.revision,3);
 assert.equal(selections.read('other','endpoint','session-a').overrideRevision,0);assert.equal(selections.read('owner','other-endpoint','session-a').overrideRevision,0);
});

test('speech pose mappings require the additive schema and bounded explicit cue data',t=>{
 const f=fixture();t.after(f.close);
 const value={...f.manifest,schemaVersion:'1.3.0',animations:{mouthAmplitude:'mouth.open'},capabilities:{lipSync:'amplitude',facialAnimation:false},speech:{cueSet:'neutral-two-poses',poses:{open:'mouth.open',rest:'mouth.rest'},transitionSeconds:.04}};
 assert.equal(validatePresentation(value).speech?.poses.open,'mouth.open');assert.throws(()=>validatePresentation({...value,animations:{}}),/mapping/);
 for(const schemaVersion of ['1.0.0','1.1.0','1.2.0'])assert.throws(()=>validatePresentation({...value,schemaVersion}),/Unsupported/);
 for(const transitionSeconds of [-1,.101,NaN,Infinity,'fast'])assert.throws(()=>validatePresentation({...value,speech:{...value.speech,transitionSeconds}}),/transition/);
 for(const poses of [{},{'not a cue':'pose'},{open:''},Object.fromEntries(Array.from({length:33},(_,i)=>['cue'+i,'pose']))])assert.throws(()=>validatePresentation({...value,speech:{...value.speech,poses}}),/mapping/);
 assert.throws(()=>validatePresentation({...value,speech:{...value.speech,script:'run'}}),/Unsupported/);
 assert.throws(()=>validatePresentation({...value,capabilities:{lipSync:'none',facialAnimation:false}}),/mapping/);
 assert.equal(validatePresentation(f.manifest).schemaVersion,'1.0.0');
});
