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
import {bundleAppearances} from '../scripts/bundle-appearances.mjs';
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
 const motion=Buffer.from(new Float32Array([0,1,2,0,0,0,.1,0,0,0,0,0]).buffer);
 const model=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Synthetic'}],scene:0,buffers:[{byteLength:motion.length,uri:'motion.bin'}],bufferViews:[{buffer:0,byteOffset:0,byteLength:12},{buffer:0,byteOffset:12,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'SCALAR',min:[0],max:[2]},{bufferView:1,componentType:5126,count:3,type:'VEC3'}],animations:[{name:'idle',samplers:[{input:0,output:1,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}]}));
 await writeFile(join(pack,'model.gltf'),model);await writeFile(join(pack,'motion.bin'),motion);await writeFile(join(packs,'index.json'),JSON.stringify(['synthetic-model']));
 const manifest={schemaVersion:'1.0.0',id:'synthetic-model',version:'1',label:'Synthetic model',renderer:'three-glb.v1',model:'model.gltf',resources:[{path:'model.gltf',sha256:createHash('sha256').update(model).digest('hex'),bytes:model.length,mime:'model/gltf+json'},{path:'motion.bin',sha256:createHash('sha256').update(motion).digest('hex'),bytes:motion.length,mime:'application/octet-stream'}],framing:{distance:1.2,targetHeight:.5},animations:{idle:'idle'},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral'};
 await writeFile(join(pack,'manifest.json'),JSON.stringify(manifest));app.presentationPackages=new PresentationPackages({directory:packs,ownerPrincipalId:identity.session.principalId});
 const assistants=[];
 for(const name of ['Synthetic mobile one','Synthetic mobile two']){
  const a=await request('/api/admin/v1/assistants',{displayName:name});
  const operation={method:'POST',path:`/api/admin/v1/assistants/${a.assistantId}/activate`,body:{profileId:a.profile.profileId,expectedActiveRevision:null},expectedRevision:null};
  const proposal=await request('/api/auth/v1/proposals',{operation});await request(`/api/auth/v1/proposals/${proposal.proposalId}/approve`,{reviewedDigest:proposal.digest,humanConfirmed:true});
  await request(`/api/admin/v1/assistants/${a.assistantId}/relationships`,{});assistants.push(a.assistantId);
 }
 return {root,endpoint,password,assistants,packs,app};
}

test('actual Foundation transport signs in, binds mobile scope and completes fixture speech protocol',{timeout:90000},async t=>{
 const f=await fixture(t),result=await nativeTransportProbe({endpoint:f.endpoint,password:f.password,assistantId:f.assistants[0]});
 assert.equal(result.nativeTransport,'pass');assert.ok(result.fixtureAudioChunks>0);assert.ok(result.fixtureSamples>0);assert.equal(result.physicalPlayback,false);t.diagnostic(JSON.stringify(result));
});

test('mobile interface uses real isolated account/audience/appearance APIs; audio controls are simulated',{timeout:90000},async t=>{
 const f=await fixture(t),web=join(f.root,'web');await mkdir(web);
 const entry=join(f.root,'entry.js');await writeFile(entry,`import {installApp} from ${JSON.stringify(new URL('../web/controller.js',import.meta.url).pathname)};
 let listener,active=false;window.calls=[];window.failStart=false;window.emit=e=>listener(e);
 window.app=installApp({restoreConnection:window.restoreNative,forgetSession:window.forgetNative,saveSettings:window.saveNativeSettings,sendText:window.sendNativeText,cancelText:window.cancelNativeText,configure:async(input)=>{await window.configureNative(input);window.calls.push('configure')},request:window.nativeRequest,addListener:async(_,fn)=>{listener=fn},start:async(input)=>{window.calls.push(input);if(window.failStart)throw Error('Synthetic microphone denial');active=true;const state={active,phase:'Listening',route:'Simulated headphones'};listener({type:'state',state});return state},stop:async()=>{await window.cancelNativeText();active=false;window.calls.push('stop');const state={active,phase:'Stopped'};listener({type:'state',state});return state},snapshot:async()=>({active,phase:'Stopped'}),routePicker:async()=>window.calls.push('routePicker')});`);
 await bundleWeb({entryPoints:[entry],outfile:join(web,'app.js')});await bundleAppearances(web,{directory:f.packs,ids:['synthetic-model']});for(const file of ['index.html','app.css'])await copyFile(new URL('../web/'+file,import.meta.url),join(web,file));
 const server=createServer(async(req,res)=>{try{const path=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','app.css','app.js','bundled-appearances.json','appearances/synthetic-model/model.gltf','appearances/synthetic-model/motion.bin'].includes(path)){res.writeHead(404).end();return}res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(join(web,path)));}catch{res.writeHead(500).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});page.setDefaultTimeout(8000);let cookie='',csrf='',holdContext=false,releaseContext,savedConnection=null,savedSettings='{}',failRestore=false,holdText=false,releaseText,textCancelled=false,textFailure=false,restoreAuthState=null;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('restoreNative',async()=>{
  if(!savedConnection)return {hasSession:false,authState:'needsSignIn'};
  const metadata={...savedConnection,settings:savedSettings,hasSavedCredentials:!!cookie};
  if(failRestore)return {...metadata,hasSession:false,authState:'offline'};
  if(restoreAuthState)return {...metadata,hasSession:false,authState:restoreAuthState};
  if(!cookie)return {...metadata,hasSession:false,authState:'needsSignIn'};
  const r=await fetch(f.endpoint+'/api/auth/v1/session',{headers:{origin:f.endpoint,cookie}}),account=await r.json();csrf=account.csrfToken??csrf;
  assert.equal(r.status,200);return {...metadata,hasSession:true,authState:'authenticated',account};
 });
 await page.exposeFunction('configureNative',input=>{savedConnection={endpoint:input.endpoint,username:input.username};cookie='';csrf='';});
 await page.exposeFunction('forgetNative',()=>{cookie='';csrf='';});
 await page.exposeFunction('saveNativeSettings',({settings})=>{savedSettings=settings;});
 await page.exposeFunction('holdNextContext',()=>{holdContext=true;});
 await page.exposeFunction('nativeRequest',async({path,method,body})=>{
  if(failRestore&&path==='/api/auth/v1/session')throw Error('Synthetic network interruption');
  if(holdContext&&path==='/api/runtime/v1/session-context'){holdContext=false;await new Promise(resolve=>{releaseContext=resolve;});}
  assert.ok(!path.includes('/presentation'),'Appearance loading must not use the server');
  const r=await fetch(f.endpoint+path,{method,headers:{origin:f.endpoint,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf},...(body?{body}:{})});
  if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(path.includes('/presentation/resources/'))return {status:r.status,body:Buffer.from(await r.arrayBuffer()).toString('base64'),encoding:'base64'};const text=await r.text();try{const value=JSON.parse(text);csrf=value.session?.csrfToken??value.csrfToken??csrf;}catch{}
  return {status:r.status,body:text,encoding:'utf8'};
 });
 await page.exposeFunction('cancelNativeText',()=>{textCancelled=true;releaseText?.();});
 await page.exposeFunction('sendNativeText',async input=>{
  textCancelled=false;windowTextCalls.push(input);if(textFailure)throw Error('Synthetic backend unavailable');
  if(holdText){holdText=false;await new Promise(resolve=>{releaseText=resolve;});releaseText=null;}
  if(textCancelled)return {trace:input.trace,text:'STALE_CANCELLED_REPLY'};
  const r=await fetch(f.endpoint+'/api/runtime/v1/messages',{method:'POST',headers:{origin:f.endpoint,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf},body:JSON.stringify({assistantId:input.assistantId,userInput:input.userInput})});assert.equal(r.status,200);
  let text='';for(const block of (await r.text()).split('\n\n')){const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(event==='message.delta')text+=JSON.parse(data).text;assert.notEqual(event,'interaction.error');}
  return {trace:input.trace,text};
 });const windowTextCalls=[];
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#status').filter({hasText:'Connect to'}).waitFor();
 await page.evaluate(()=>{window.clicked=new Set();document.addEventListener('click',event=>{const button=event.target.closest('button');if(button)window.clicked.add(button.id||button.type);});});
 assert.equal(await page.locator('#input-status').count(),1,'input activity indicator exists');assert.equal(await page.locator('#backend-status').count(),1);assert.equal(await page.locator('#output-status').count(),1);assert.equal(await page.locator('#send-text').isDisabled(),true);
 assert.equal(await page.locator('#start').isDisabled(),true);
 await page.locator('#routes').click();assert.ok(await page.evaluate(()=>window.calls.includes('routePicker')));
 assert.equal(await page.locator('#connection').isVisible(),false);await page.locator('#open-settings').click();assert.equal(await page.locator('#settings-pane').isVisible(),true);assert.equal(await page.locator('#main-pane').isVisible(),false);
 await page.locator('#server').fill(f.endpoint);await page.locator('#username').fill('ios-fixture');await page.locator('#password').fill(f.password);await page.locator('#connection button[type=submit]').click();
 await page.waitForFunction(()=>!!window.app.state.session);await page.locator('#open-settings').click();await page.locator('#session-panel').waitFor();await page.waitForFunction(()=>document.querySelector('#assistant').options.length===3,{},{timeout:5000}).catch(async error=>{throw Error((await page.locator('#status').textContent())+' '+errors.join(';')+' '+error.message)});
 assert.equal(await page.locator('#password').inputValue(),'');assert.equal(await page.locator('#assistant option').nth(1).textContent(),'Assistant 1');
 await page.locator('#assistant').selectOption(f.assistants[0]);await page.locator('#close-settings').click();await page.locator('#private').click();await page.waitForFunction(()=>window.app.state.privateAllowed&&document.querySelector('#intro').hidden).catch(async e=>{throw Error((await page.locator('#status').textContent())+' '+errors.join(';')+' '+e.message)});
 assert.match(await page.locator('#assistant option').nth(1).textContent(),/Synthetic/);await page.locator('#open-settings').click();
 await page.locator('#assistant').selectOption(f.assistants[1]);await page.locator('#appearance').selectOption('synthetic-model');await page.locator('#apply-appearance').click();await page.locator('#status').filter({hasText:'Appearance applied'}).waitFor();await page.getByLabel('Idle',{exact:true}).uncheck();assert.equal(Object.values(JSON.parse(savedSettings).disabledAnimations).filter(Boolean).length,1);await page.locator('#appearance').selectOption('neutral');await page.locator('#apply-appearance').click();await page.locator('#status').filter({hasText:'Appearance applied'}).waitFor();
 await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#apply-appearance').disabled);
 await page.locator('#close-settings').click();await page.locator('#text-input').fill('Synthetic typed question');await page.locator('#send-text').click();await page.locator('#status').filter({hasText:'Text reply received'}).waitFor();assert.match(await page.locator('#transcript').textContent(),/Synthetic typed question/);assert.match(await page.locator('#transcript').textContent(),/Fixture response/);assert.equal(await page.locator('#output-status').textContent(),'Text received');assert.equal(await page.evaluate(()=>window.calls.filter(x=>typeof x==='object').length),0,'text does not start native audio');assert.equal(windowTextCalls.length,1);
 textFailure=true;await page.locator('#text-input').fill('Failed typed message');await page.locator('#send-text').click();await page.locator('#status').filter({hasText:'Synthetic backend unavailable'}).waitFor();assert.equal(await page.locator('#backend-status').textContent(),'Request failed');assert.equal(await page.locator('#stop').isDisabled(),true);textFailure=false;
 holdText=true;await page.locator('#text-input').fill('Cancel this typed message');await page.locator('#send-text').click();await page.waitForFunction(()=>document.querySelector('#backend-status').textContent==='Processing text');await page.locator('#stop').click();await page.waitForTimeout(50);assert.doesNotMatch(await page.locator('#transcript').textContent(),/STALE_CANCELLED_REPLY/);assert.equal(await page.locator('#send-text').isDisabled(),true);await page.locator('#open-settings').click();

 await page.locator('#close-settings').click();await page.evaluate(()=>window.failStart=true);await page.locator('#start').click();await page.locator('#status').filter({hasText:'microphone denial'}).waitFor();assert.equal(await page.locator('#start').isDisabled(),false);
 await page.evaluate(()=>window.failStart=false);
 const beforeStarts=await page.evaluate(()=>window.calls.filter(x=>typeof x==='object').length);await page.evaluate(()=>window.holdNextContext());await page.locator('#start').click();await page.locator('#stop').click();releaseContext();await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>window.calls.filter(x=>typeof x==='object').length),beforeStarts,'Stop cancels a Start still preparing its session');
 await page.evaluate(()=>window.holdNextContext());await page.locator('#start').click();await page.locator('#shared').click();releaseContext();await page.locator('#status').filter({hasText:'Private context and display cleared'}).waitFor();assert.equal(await page.locator('#start').isDisabled(),false,'Shared cancels a preparing Start without leaving controls busy');await page.locator('#private').click();await page.waitForFunction(()=>window.app.state.privateAllowed);
 await page.locator('#open-settings').click();await page.locator('#background').check();await page.locator('#close-settings').click();await page.locator('#start').click();await page.locator('#status').filter({hasText:'Listening'}).waitFor();
 assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#shared').isDisabled(),false);
 await page.evaluate(()=>{document.querySelector('#transcript').replaceChildren();window.emit({type:'state',state:{active:true,phase:'Transcribing',inputStage:'capturing',inputLevel:.03,inputFrames:7,backendStage:'transcribing',outputStage:'idle'}});window.emit({type:'transcript',text:'Synthetic foreground question',trace:'fixture'});window.emit({type:'textDelta',text:'Synthetic reply',trace:'fixture'});});assert.equal(await page.locator('#transcript li').count(),2);assert.equal(await page.locator('#input-status').textContent(),'Speech detected');assert.equal(await page.locator('#backend-status').textContent(),'Transcribing');assert.ok(await page.locator('#input-level').evaluate(node=>node.value)>0);
 await page.evaluate(()=>window.emit({type:'state',state:{active:true,phase:'Speaking',inputStage:'listening',inputLevel:.01,inputFrames:8,backendStage:'idle',outputStage:'playing',playing:true}}));assert.equal(await page.locator('#output-status').textContent(),'Playing speech');
 const output=process.env.IOS_EVIDENCE_DIRECTORY;if(output){await mkdir(output,{recursive:true});await page.screenshot({path:join(output,'ios-mobile-conversation.png'),fullPage:true});}
 const previousCanvas=await page.locator('#avatar').evaluate(node=>{node.dataset.stale='private-frame';return true;});assert.ok(previousCanvas);
 await page.locator('#shared').click();await page.waitForFunction(()=>!window.app.state.privateAllowed&&document.querySelector('#transcript').children.length===0);assert.equal(await page.locator('#intro').isVisible(),true);assert.equal(await page.locator('#avatar').getAttribute('data-stale'),'private-frame');assert.equal(await page.locator('#avatar').evaluate(node=>node.getContext('2d')?.getImageData(0,0,1,1).data[3]),0,'private WebGL pixels are absent from replacement canvas');
 await page.locator('#start').click();await page.locator('#stop').click();assert.equal(await page.locator('#stop').isDisabled(),true);
 await page.locator('#private').click();await page.waitForFunction(()=>window.app.state.privateAllowed);await page.evaluate(()=>window.emit({type:'state',state:{active:false,phase:'Audience declaration expired.'}}));assert.equal(await page.locator('#transcript li').count(),0);
 // Visibility revocation disposes rendering even if a stale listener emits private text.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.emit({type:'textDelta',text:'DO_NOT_SHOW',trace:'late'});});assert.equal(await page.locator('#transcript').textContent(),'');
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 for(const width of [320,390,844]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow ${width}`);}
 const callsBeforeReload=await page.evaluate(()=>window.calls),clickedBeforeReload=await page.evaluate(()=>window.clicked.size);const selectedBeforeReload=JSON.parse(savedSettings).assistantId;
 restoreAuthState='needsOneTimeCode';await page.reload();await page.locator('#status').filter({hasText:'previous sign-in used an authenticator code'}).waitFor();assert.equal(await page.locator('#settings-pane').isVisible(),true);assert.equal(await page.locator('#password').inputValue(),'');restoreAuthState=null;
 failRestore=true;await page.reload();await page.locator('#status').filter({hasText:'currently unavailable'}).waitFor();assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#server').inputValue(),f.endpoint);failRestore=false;await page.locator('#open-settings').click();await page.locator('#retry-connection').click();await page.waitForFunction(()=>!!window.app.state.session&&document.querySelector('#retry-connection').hidden);await page.waitForFunction(()=>document.querySelector('#assistant').options.length===3);
 assert.equal(await page.locator('#assistant').inputValue(),selectedBeforeReload);assert.equal(await page.evaluate(()=>window.app.state.privateAllowed),false);assert.equal(await page.locator('#stop').isDisabled(),true);assert.equal(await page.locator('#background').isChecked(),false);assert.equal(await page.locator('#password').inputValue(),'');assert.equal(Object.values(JSON.parse(savedSettings).disabledAnimations).filter(Boolean).length,1);
 await page.setViewportSize({width:390,height:844});await page.locator('#open-settings').click();await page.locator('#sign-out').click();await page.locator('#status').filter({hasText:'Signed out'}).waitFor();assert.equal(await page.locator('#start').isDisabled(),true);
 if(output)await page.screenshot({path:join(output,'ios-mobile-sign-in.png'),fullPage:true});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#server').value);assert.equal(await page.locator('#server').inputValue(),f.endpoint);assert.equal(await page.locator('#username').inputValue(),'ios-fixture');assert.equal(await page.locator('#password').inputValue(),'');assert.equal(await page.locator('#start').isDisabled(),true);assert.ok(selectedBeforeReload);
 assert.deepEqual(errors,[]);assert.ok(callsBeforeReload.some(x=>x.background===true));assert.equal(clickedBeforeReload,await page.locator('button').count()-2);t.diagnostic('Main/Settings controls plus persisted Assistant/appearance/animation choices, connection disclosure, failed Start, privacy and viewport checks passed. Native audio simulated.');
});


test('native connection restores with saved credentials after expiry and clears secrets on sign-out or origin change',{timeout:180000},async t=>{
 const f=await fixture(t),input={probe:'persistence-probe.swift',endpoint:f.endpoint,password:f.password,storePath:join(f.root,'test-native-store.json')};
 const signed=await nativeTransportProbe({...input,mode:'signin'});assert.equal(signed.status,200);assert.equal(signed.hasSession,true);
 const raw=await readFile(input.storePath,'utf8');assert.equal(JSON.parse(raw).password,f.password,'successful sign-in must retain the password in the native secure store');assert.ok(!raw.includes('csrfToken'));
 const restored=await nativeTransportProbe({...input,mode:'restore'});assert.equal(restored.status,200);assert.equal(restored.username,'ios-fixture');assert.equal(restored.endpoint,f.endpoint);assert.equal(restored.csrfAvailable,true);assert.equal(restored.restored.authState,'authenticated');assert.ok(restored.restored.account.sessionId);assert.equal(restored.restored.account.csrfToken,undefined);assert.equal(restored.restored.account.token,undefined);assert.ok(!JSON.stringify(restored).includes(f.password));
 // Revocation/expiry invalidates the old session but does not disable the account's password.
 f.app.database.connection.prepare('UPDATE local_sessions SET revoked=1').run();const revoked=await nativeTransportProbe({...input,mode:'restore'});assert.equal(revoked.status,200);assert.equal(revoked.hasSession,true);assert.equal(revoked.username,'ios-fixture');assert.notEqual(revoked.restored.account.sessionId,restored.restored.account.sessionId);
 const signedOut=await nativeTransportProbe({...input,mode:'signout'});assert.equal(signedOut.hasSession,false);assert.equal(signedOut.hasSavedCredentials,false);assert.equal(signedOut.username,'ios-fixture');assert.ok(!(await readFile(input.storePath,'utf8')).includes(f.password));
 const coldSignedOut=await nativeTransportProbe({...input,mode:'restore'});assert.equal(coldSignedOut.status,0);assert.equal(coldSignedOut.restored.authState,'needsSignIn');
 await nativeTransportProbe({...input,mode:'signin'});
 const changed=await nativeTransportProbe({...input,mode:'change',endpoint:'http://127.0.0.1:1'});assert.equal(changed.hasSession,false);assert.equal(changed.hasSavedCredentials,false);assert.equal(changed.username,'other');assert.equal(changed.csrfAvailable,false);
 const failed=await nativeTransportProbe({...input,mode:'signin',password:'incorrect-password'});assert.equal(failed.status,401);assert.equal(failed.hasSavedCredentials,false);
 await nativeTransportProbe({...input,mode:'signin'});
 // A rejected saved password is attempted once, then removed rather than retried at every launch.
 const record=JSON.parse(await readFile(input.storePath,'utf8'));record.password='incorrect-password';record.cookies=[];await writeFile(input.storePath,JSON.stringify(record));
 const rejected=await nativeTransportProbe({...input,mode:'restore'});assert.equal(rejected.restored.authState,'needsSignIn');assert.equal(rejected.hasSavedCredentials,false);
 const attempts=()=>f.app.database.connection.prepare('SELECT SUM(attempts) AS count FROM local_auth_attempts').get().count;
 const afterFailure=attempts();await nativeTransportProbe({...input,mode:'restore'});assert.equal(attempts(),afterFailure);
 // Supplying an OTP on a successful sign-in records only its requirement, never the code.
 await nativeTransportProbe({...input,mode:'signin',totp:'987654'});const otpRecord=JSON.parse(await readFile(input.storePath,'utf8'));assert.equal(otpRecord.requiresOneTimeCode,true);assert.ok(!JSON.stringify(otpRecord).includes('987654'));
 f.app.database.connection.prepare('UPDATE local_sessions SET revoked=1').run();const beforeOtp=attempts(),otp=await nativeTransportProbe({...input,mode:'restore'});assert.equal(otp.restored.authState,'needsOneTimeCode');assert.equal(otp.hasSavedCredentials,true);assert.equal(otp.hasSession,false);assert.equal(attempts(),beforeOtp);
});
