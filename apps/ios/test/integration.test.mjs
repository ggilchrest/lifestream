import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {createLifestreamServer} from '../../server/src/index.ts';
import {loadProfile} from '../../server/src/config/loader.ts';
import {PresentationPackages} from '../../server/src/admin/presentation-packages.ts';
import {nativeTransportProbe} from '../scripts/test-transport.mjs';
import {bundleWeb} from '../scripts/build-web.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ls-ios-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();t.after(()=>app.shutdown());
 // Test-only provider injection: current fixture profile has no concrete STT/TTS ports.
 app.providers.stt={async *transcribe(_context,frames){for await(const _frame of frames){}yield {kind:'data',payload:{type:'committed',text:'Synthetic mobile transport question.'}};yield {kind:'terminal',outcome:'succeeded'};}};
 app.providers.tts={voiceControls:async()=>({description:false,reference:false}),async *synthesize(request){for(let i=0;i<3;i++)yield {kind:'data',segmentId:request.segmentId,frame:{frameId:crypto.randomUUID(),sequence:i,sampleOffset:i*4800,sampleCount:4800,format:request.format,dataBase64:Buffer.alloc(9600,8).toString('base64')}};yield {kind:'terminal',outcome:'succeeded'};}};
 const endpoint=`http://127.0.0.1:${app.address().port}`;
 let cookie='',csrf='';
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{origin:endpoint,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const json=await r.json();csrf=json.session?.csrfToken??json.csrfToken??csrf;assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(json)}`);return json;};
 const identity=await request('/api/auth/v1/setup',{username:'ios-fixture',password,installerToken});
 const packs=join(root,'packs'),pack=join(packs,'synthetic-model');await mkdir(pack,{recursive:true});
 const model=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Synthetic'}],scene:0}));
 await writeFile(join(pack,'model.gltf'),model);await writeFile(join(packs,'index.json'),JSON.stringify(['synthetic-model']));
 const manifest={schemaVersion:'1.0.0',id:'synthetic-model',version:'1',label:'Synthetic model',renderer:'three-glb.v1',model:'model.gltf',resources:[{path:'model.gltf',sha256:createHash('sha256').update(model).digest('hex'),bytes:model.length,mime:'model/gltf+json'}],framing:{distance:1.2,targetHeight:.5},animations:{},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral'};
 await writeFile(join(pack,'manifest.json'),JSON.stringify(manifest));app.presentationPackages=new PresentationPackages({directory:packs,ownerPrincipalId:identity.session.principalId});
 const assistants=[];
 for(const name of ['Synthetic mobile one','Synthetic mobile two']){
  const a=await request('/api/admin/v1/assistants',{displayName:name});
  const operation={method:'POST',path:`/api/admin/v1/assistants/${a.assistantId}/activate`,body:{profileId:a.profile.profileId,expectedActiveRevision:null},expectedRevision:null};
  const proposal=await request('/api/auth/v1/proposals',{operation});await request(`/api/auth/v1/proposals/${proposal.proposalId}/approve`,{reviewedDigest:proposal.digest,humanConfirmed:true});
  await request(`/api/admin/v1/assistants/${a.assistantId}/relationships`,{});assistants.push(a.assistantId);
 }
 return {root,endpoint,password,assistants};
}

test('actual Foundation transport signs in, binds mobile scope and completes fixture speech protocol',{timeout:90000},async t=>{
 const f=await fixture(t),result=await nativeTransportProbe({endpoint:f.endpoint,password:f.password,assistantId:f.assistants[0]});
 assert.equal(result.nativeTransport,'pass');assert.ok(result.fixtureAudioChunks>0);assert.ok(result.fixtureSamples>0);assert.equal(result.physicalPlayback,false);t.diagnostic(JSON.stringify(result));
});

test('mobile interface uses real isolated account/audience/appearance APIs; audio controls are simulated',{timeout:90000},async t=>{
 const f=await fixture(t),web=join(f.root,'web');await mkdir(web);
 const entry=join(f.root,'entry.js');await writeFile(entry,`import {installApp} from ${JSON.stringify(new URL('../web/controller.js',import.meta.url).pathname)};
 let listener,active=false;window.calls=[];window.failStart=false;window.emit=e=>listener(e);
 window.app=installApp({configure:async()=>{window.calls.push('configure')},request:window.nativeRequest,addListener:async(_,fn)=>{listener=fn},start:async(input)=>{window.calls.push(input);if(window.failStart)throw Error('Synthetic microphone denial');active=true;const state={active,phase:'Listening',route:'Simulated headphones'};listener({type:'state',state});return state},stop:async()=>{active=false;window.calls.push('stop');const state={active,phase:'Stopped'};listener({type:'state',state});return state},snapshot:async()=>({active,phase:'Stopped'}),routePicker:async()=>window.calls.push('routePicker')});`);
 await bundleWeb({entryPoints:[entry],outfile:join(web,'app.js')});for(const file of ['index.html','app.css'])await copyFile(new URL('../web/'+file,import.meta.url),join(web,file));
 const server=createServer(async(req,res)=>{try{const path=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','app.css','app.js'].includes(path)){res.writeHead(404).end();return}res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(join(web,path)));}catch{res.writeHead(500).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});let cookie='',csrf='',holdContext=false,releaseContext;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('holdNextContext',()=>{holdContext=true;});
 await page.exposeFunction('nativeRequest',async({path,method,body})=>{
  if(holdContext&&path==='/api/runtime/v1/session-context'){holdContext=false;await new Promise(resolve=>{releaseContext=resolve;});}
  const r=await fetch(f.endpoint+path,{method,headers:{origin:f.endpoint,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf},...(body?{body}:{})});
  if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(path.includes('/presentation/resources/'))return {status:r.status,body:Buffer.from(await r.arrayBuffer()).toString('base64'),encoding:'base64'};const text=await r.text();try{const value=JSON.parse(text);csrf=value.session?.csrfToken??value.csrfToken??csrf;}catch{}
  return {status:r.status,body:text,encoding:'utf8'};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#status').filter({hasText:'Connect to'}).waitFor();
 await page.evaluate(()=>{window.clicked=new Set();document.addEventListener('click',event=>{const button=event.target.closest('button');if(button)window.clicked.add(button.id||button.type);});});
 assert.equal(await page.locator('#start').isDisabled(),true);
 await page.locator('#routes').click();assert.ok(await page.evaluate(()=>window.calls.includes('routePicker')));
 await page.locator('#server').fill(f.endpoint);await page.locator('#username').fill('ios-fixture');await page.locator('#password').fill(f.password);await page.locator('button[type=submit]').click();
 await page.locator('#session-panel').waitFor();await page.waitForFunction(()=>document.querySelector('#assistant').options.length===3,{},{timeout:5000}).catch(async error=>{throw Error((await page.locator('#status').textContent())+' '+errors.join(';')+' '+error.message)});
 assert.equal(await page.locator('#password').inputValue(),'');assert.equal(await page.locator('#assistant option').nth(1).textContent(),'Assistant 1');
 await page.locator('#assistant').selectOption(f.assistants[0]);await page.locator('#private').click();await page.waitForFunction(()=>window.app.state.privateAllowed&&document.querySelector('#intro').hidden);
 assert.match(await page.locator('#assistant option').nth(1).textContent(),/Synthetic/);
 await page.locator('#assistant').selectOption(f.assistants[1]);await page.locator('#appearance').selectOption('synthetic-model');await page.locator('#apply-appearance').click();await page.locator('#status').filter({hasText:'Appearance applied'}).waitFor();await page.locator('#appearance').selectOption('neutral');await page.locator('#apply-appearance').click();await page.locator('#status').filter({hasText:'Appearance applied'}).waitFor();
 await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#apply-appearance').disabled);
 await page.evaluate(()=>window.failStart=true);await page.locator('#start').click();await page.locator('#status').filter({hasText:'microphone denial'}).waitFor();assert.equal(await page.locator('#start').isDisabled(),false);
 await page.evaluate(()=>window.failStart=false);
 const beforeStarts=await page.evaluate(()=>window.calls.filter(x=>typeof x==='object').length);await page.evaluate(()=>window.holdNextContext());await page.locator('#start').click();await page.locator('#stop').click();releaseContext();await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>window.calls.filter(x=>typeof x==='object').length),beforeStarts,'Stop cancels a Start still preparing its session');
 await page.locator('#background').check();await page.locator('#start').click();await page.locator('#status').filter({hasText:'Listening'}).waitFor();
 assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#shared').isDisabled(),false);
 await page.evaluate(()=>{window.emit({type:'transcript',text:'Synthetic foreground question',trace:'fixture'});window.emit({type:'textDelta',text:'Synthetic reply',trace:'fixture'});});assert.equal(await page.locator('#transcript li').count(),2);
 const output=process.env.IOS_EVIDENCE_DIRECTORY;if(output){await mkdir(output,{recursive:true});await page.screenshot({path:join(output,'ios-mobile-conversation.png'),fullPage:true});}
 const previousCanvas=await page.locator('#avatar').evaluate(node=>{node.dataset.stale='private-frame';return true;});assert.ok(previousCanvas);
 await page.locator('#shared').click();await page.waitForFunction(()=>!window.app.state.privateAllowed&&document.querySelector('#transcript').children.length===0);assert.equal(await page.locator('#intro').isVisible(),true);assert.equal(await page.locator('#avatar').getAttribute('data-stale'),'private-frame');assert.equal(await page.locator('#avatar').evaluate(node=>node.getContext('2d')?.getImageData(0,0,1,1).data[3]),0,'private WebGL pixels are absent from replacement canvas');
 await page.locator('#start').click();await page.locator('#stop').click();assert.equal(await page.locator('#stop').isDisabled(),true);
 await page.locator('#private').click();await page.waitForFunction(()=>window.app.state.privateAllowed);await page.evaluate(()=>window.emit({type:'state',state:{active:false,phase:'Audience declaration expired.'}}));assert.equal(await page.locator('#transcript li').count(),0);
 // Visibility revocation disposes rendering even if a stale listener emits private text.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.emit({type:'textDelta',text:'DO_NOT_SHOW',trace:'late'});});assert.equal(await page.locator('#transcript').textContent(),'');
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 for(const width of [320,390,844]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow ${width}`);}
 await page.setViewportSize({width:390,height:844});await page.locator('summary').click();await page.locator('#sign-out').click();await page.locator('#status').filter({hasText:'Signed out'}).waitFor();assert.equal(await page.locator('#start').isDisabled(),true);
 if(output)await page.screenshot({path:join(output,'ios-mobile-sign-in.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.ok((await page.evaluate(()=>window.calls)).some(x=>x.background===true));assert.equal(await page.evaluate(()=>window.clicked.size),await page.locator('button').count());t.diagnostic('All 9 buttons plus Assistant/appearance/background controls, connection disclosure, failed Start, privacy and viewport checks passed. Native audio simulated.');
});
