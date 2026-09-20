import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {presentationVendor} from '../../server/src/runtime/presentation-vendor.ts';

test('rendered animation preview is temporary, explains fallback, rejects busy work and clears on actual state or audience change',{skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:9/**',async route=>{
  const name=new URL(route.request().url()).pathname.slice(1);
  if(!name)return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/styles.css"><script type="importmap">{"imports":{"three":"/three.module.js"}}</script><main class="shell"><section class="conversation-room"><div class="room-layout"></div></section></main>'});
  const body=await presentationVendor(name)??await readFile(new URL('../'+name,import.meta.url));
  return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body});
 });await page.goto('http://127.0.0.1:9/#conversation');
 await page.evaluate(async()=>{
  window.lifestreamAuth={session:{principalId:'synthetic'}};window.previewBusy=false;window.presentationWrites=0;
  const {PresentationRuntime}=await import('/presentation-runtime.js'),preview=PresentationRuntime.prototype.preview;
  PresentationRuntime.prototype.preview=function(...args){window.previewRuntime=this;return preview.apply(this,args);};
  const {installPresentation}=await import('/presentation.js');
  window.presentation=installPresentation({anchor:document.querySelector('main'),busy:()=>window.previewBusy,playback:()=>({playing:false}),identity:()=>({assistantId:'synthetic-assistant'}),api:async(_path,options)=>{if(options)window.presentationWrites++;return {endpointId:'synthetic-endpoint',packages:[],neutral:{id:'neutral',label:'Neutral reference',digest:'neutral-v1'},selection:{default:null,override:null}};}});
  window.presentation.refresh();
 });
 await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);await page.getByText('Preview animations',{exact:true}).click();
 for(const state of ['idle','listening','preparing','speaking','interrupted','working','waiting','failure']){
  await page.getByLabel('Animation preview state').selectOption(state);await page.getByRole('button',{name:'Preview animation',exact:true}).click();
  await page.waitForFunction(state=>document.querySelector('.presentation-state').textContent==='Preview: '+state,state);
  assert.match(await page.locator('[data-preview-status]').textContent(),/no mapped animation/);
  assert.equal(await page.evaluate(()=>window.previewRuntime.semantic?.speechState),'silent');
  await page.getByRole('button',{name:'End preview',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.presentation-state').textContent.startsWith('Preview:'));
 }
 await page.getByRole('button',{name:'Preview animation',exact:true}).click();await page.evaluate(()=>window.previewRuntime.previewState.until=performance.now()-1);await page.waitForFunction(()=>document.querySelector('[data-preview-status]').textContent.startsWith('Preview ended'));
 await page.getByRole('button',{name:'Preview animation',exact:true}).click();await page.evaluate(()=>window.presentation.state('preparing'));await page.waitForFunction(()=>document.querySelector('.presentation-state').textContent==='preparing');
 await page.evaluate(()=>{window.previewBusy=true;});await page.getByRole('button',{name:'Preview animation',exact:true}).click();assert.match(await page.locator('.presentation-controls > [role="status"]').textContent(),/Wait until/);assert.equal(await page.evaluate(()=>!!window.previewRuntime.previewState),false);
 await page.evaluate(async()=>{
  window.previewBusy=false;window.presentation.state('idle');
  const THREE=await import('three'),runtime=window.previewRuntime,value=runtime.current;
  value.manifest.animations=Object.fromEntries(['idle','listening','preparing','speaking','interrupted','working','waiting','failure'].map(state=>[state,state+'-clip']));value.manifest.transitionSeconds=.1;
  value.mixer=new THREE.AnimationMixer(value.root);value.actions=new Map(Object.values(value.manifest.animations).map((name,i)=>[name,value.mixer.clipAction(new THREE.AnimationClip(name,1,[new THREE.NumberKeyframeTrack('.rotation[z]',[0,1],[(i+1)*.01,(i+1)*.01])]))]));
 });
 for(const [i,state] of ['idle','listening','preparing','speaking','interrupted','working','waiting','failure'].entries()){
  await page.getByLabel('Animation preview state').selectOption(state);await page.getByRole('button',{name:'Preview animation',exact:true}).click();
  await page.waitForFunction(({state,angle})=>window.previewRuntime.current.action?.getClip().name===state+'-clip'&&Math.abs(window.previewRuntime.current.root.rotation.z-angle)<.0001,{state,angle:(i+1)*.01});
  assert.match(await page.locator('[data-preview-status]').textContent(),/uses its declared animation/);assert.equal(await page.evaluate(()=>window.previewRuntime.semantic?.speechState),'silent');
 }
 if(process.env.LIFESTREAM_PREVIEW_SCREENSHOT){
  await page.screenshot({path:process.env.LIFESTREAM_PREVIEW_SCREENSHOT.replace(/\.png$/,'-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:process.env.LIFESTREAM_PREVIEW_SCREENSHOT,fullPage:true});
 }
 // Let a real five-second lease expire, then verify canonical idle motion returns.
 await page.waitForFunction(()=>!window.previewRuntime.previewState,{},{timeout:7000});await page.waitForFunction(()=>Math.abs(window.previewRuntime.current.root.rotation.z-.01)<.0001);
 await page.evaluate(()=>{window.previewRuntime.current.manifest.transitionSeconds=0;});await page.getByRole('button',{name:'Preview animation',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.previewRuntime.current.actions.get('idle-clip').isRunning()),false);
 await page.evaluate(()=>{window.previewBusy=false;window.presentation.state('idle');});await page.getByRole('button',{name:'Preview animation',exact:true}).click();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lifestream-audience',{detail:{privateAllowed:false}})));assert.equal(await page.evaluate(()=>window.previewRuntime.disposed),true);assert.equal(await page.evaluate(()=>!!window.previewRuntime.previewState),false);
 assert.equal(await page.evaluate(()=>window.presentationWrites),0);assert.deepEqual(errors,[]);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
});

test('rendered face previews use mapped layers, disclose absence, and stop for turns, timeout, audience and navigation',{skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:9/**',async route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!name)return route.fulfill({contentType:'text/html',body:'<script type="importmap">{"imports":{"three":"/three.module.js"}}</script><main><section class="room-layout"></section></main><style>canvas{width:400px;height:400px}</style>'});const body=await presentationVendor(name)??await readFile(new URL('../'+name,import.meta.url));return route.fulfill({contentType:'text/javascript',body});});await page.goto('http://127.0.0.1:9/#conversation');
 await page.evaluate(async()=>{window.lifestreamAuth={session:{principalId:'synthetic'}};window.presentationIdentity={assistantId:'synthetic',relationshipId:'relationship-a',endpointId:'test'};window.busy=false;const {PresentationRuntime}=await import('/presentation-runtime.js'),method=PresentationRuntime.prototype.previewFace;PresentationRuntime.prototype.previewFace=function(...args){window.faceRuntime=this;return method.apply(this,args);};const {installPresentation}=await import('/presentation.js');window.presentation=installPresentation({anchor:document.querySelector('main'),busy:()=>window.busy,playback:()=>({playing:false}),identity:()=>window.presentationIdentity,api:async()=>({endpointId:'test',packages:[],neutral:{id:'neutral',label:'Neutral',digest:'neutral-v1'},selection:{}})});window.presentation.refresh();});
 await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);await page.getByText('Preview animations',{exact:true}).click();await page.getByRole('button',{name:'Preview face motion',exact:true}).click();assert.match(await page.locator('.presentation-controls > [role=status]').textContent(),/no blink mapping/);
 await page.evaluate(async()=>{window.installFaceFixtures=async()=>{const T=await import('three'),{FaceMotion}=await import('/presentation-motion.js'),value=window.faceRuntime.current;const eye=new T.Bone(),lid=new T.Bone();eye.name='Eye';lid.name='Lid';value.root.add(eye,lid);const q=new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),.5),clip=new T.AnimationClip('closed',1,[new T.QuaternionKeyframeTrack('Lid.quaternion',[0,1],[0,0,0,1,...q.toArray()])]);value.manifest.face={gaze:{nodes:[{node:'Eye',yawAxis:[0,1,0],pitchAxis:[1,0,0]}],yawLimit:.25,pitchLimit:.15},blink:{clip:'closed',periodSeconds:4,durationSeconds:.2}};value.faceMotion=new FaceMotion(value.root,[clip],value.manifest.face);};await window.installFaceFixtures();});
 await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>{dispatchEvent(new CustomEvent('lifestream-assistant'));dispatchEvent(new CustomEvent('lifestream-relationship'));});assert.equal(await page.evaluate(()=>window.faceRuntime.disposed),false,'Repeated unchanged scope notifications must retain the loaded appearance');assert.equal(await page.evaluate(()=>window.faceRuntime.facePreview.mode),'blink');await page.getByRole('button',{name:'End preview',exact:true}).click();
 for(const mode of ['blink','left','right','up','down','center']){await page.getByLabel('Face preview motion').selectOption(mode);await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.waitForFunction(mode=>document.querySelector('.presentation-state').textContent==='Face preview: '+mode,mode);assert.equal(await page.evaluate(()=>window.faceRuntime.playback().playing),false);assert.equal(await page.evaluate(()=>Object.hasOwn(window.faceRuntime.semantic??{},'relationshipId')),false);await page.getByRole('button',{name:'End preview',exact:true}).click();await page.waitForFunction(()=>!window.faceRuntime.facePreview);}
 await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>location.hash='#account');await page.waitForFunction(()=>window.faceRuntime.disposed);assert.equal(await page.evaluate(()=>window.faceRuntime.facePreview),null);await page.evaluate(()=>location.hash='#conversation');await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>window.installFaceFixtures());
 await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>{window.presentationIdentity.relationshipId='relationship-b';dispatchEvent(new CustomEvent('lifestream-relationship'));});await page.waitForFunction(()=>window.faceRuntime.disposed);assert.equal(await page.evaluate(()=>window.faceRuntime.facePreview),null);await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>window.installFaceFixtures());
 await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>window.faceRuntime.facePreview.until=0);await page.waitForFunction(()=>!window.faceRuntime.facePreview);
 await page.getByRole('button',{name:'Preview face motion',exact:true}).click();await page.evaluate(()=>window.presentation.state('preparing'));assert.equal(await page.evaluate(()=>window.faceRuntime.facePreview),null);
 await page.evaluate(()=>window.busy=true);await page.getByRole('button',{name:'Preview face motion',exact:true}).click();assert.match(await page.locator('.presentation-controls > [role=status]').textContent(),/Wait until/);await page.evaluate(()=>window.busy=false);
 await page.getByRole('button',{name:'Preview face motion',exact:true}).click();assert.doesNotMatch(await page.locator('.presentation-controls > [role=status]').textContent(),/Wait until/);await page.evaluate(()=>dispatchEvent(new CustomEvent('lifestream-audience',{detail:{privateAllowed:false}})));assert.equal(await page.evaluate(()=>window.faceRuntime.disposed),true);assert.equal(await page.evaluate(()=>window.faceRuntime.facePreview),null);assert.deepEqual(errors,[]);
});

test('rendered appearance selection honors session precedence, clears overrides and never adopts a changed digest implicitly',{skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:9/**',async route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!name)return route.fulfill({contentType:'text/html',body:'<main><div class="room-layout"></div></main>'});if(name==='presentation-runtime.js')return route.fulfill({contentType:'text/javascript',body:'export class PresentationRuntime { constructor(){window.selectionRuntime=this;this.current={id:"neutral",label:"Neutral reference"};} async prepare(item){window.prepared.push(item.id+":"+item.digest);if(item.id===window.rejectPackage)throw Error("Invalid mapped clip");return {...item};} commit(value){this.current=value;window.committed.push(value.id+":"+value.digest);} release(){} dispose(){this.disposed=true;} }'});return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+name,import.meta.url))});});await page.goto('http://127.0.0.1:9/#conversation');
 await page.evaluate(async()=>{
  window.lifestreamAuth={session:{principalId:'owner'}};window.prepared=[];window.committed=[];window.writes=[];window.selectionBusy=false;
  const item=(id,digest)=>({id,digest,label:id,manifest:{capabilities:{lipSync:'none'}}});window.catalog=[item('endpoint-a','a1'),item('session-b','b1'),item('endpoint-c','c1')];window.selection={default:{id:'endpoint-a',digest:'a1',revision:1},override:{id:'session-b',digest:'b1',revision:1}};
  const {installPresentation}=await import('/presentation.js');window.presentation=installPresentation({anchor:document.querySelector('main'),busy:()=>window.selectionBusy,playback:()=>({playing:false}),identity:()=>({assistantId:'fixture'}),api:async(_path,options)=>{if(options){const body=JSON.parse(options.body);window.writes.push(body);if(body.operation==='clearSessionOverride'){window.selection.overrideRevision=window.selection.override.revision+1;window.selection.override=null;}else{const key=body.scope==='default'?'default':'override';window.selection[key]={id:body.id,digest:body.digest,revision:body.expectedRevision+1};}}return structuredClone({endpointId:'one',packages:window.catalog,neutral:{id:'neutral',label:'Neutral reference',digest:'neutral-v1'},selection:window.selection});}});window.presentation.refresh();
 });
 await page.waitForFunction(()=>window.selectionRuntime?.current.id==='session-b');
 await page.getByLabel('Appearance',{exact:true}).selectOption('endpoint-c');await page.getByRole('button',{name:'Apply appearance',exact:true}).click();await page.waitForFunction(()=>window.selection.default.id==='endpoint-c');
 assert.equal(await page.evaluate(()=>window.selectionRuntime.current.id),'session-b','saving a default cannot replace the active session override');
 await page.getByRole('button',{name:'Use endpoint default',exact:true}).click();await page.waitForFunction(()=>window.selection.override===null);await page.waitForFunction(()=>window.selectionRuntime.current.id==='endpoint-c');
 await page.getByLabel('Appearance scope').selectOption('session');await page.getByLabel('Appearance',{exact:true}).selectOption('session-b');await page.getByRole('button',{name:'Apply appearance',exact:true}).click();await page.waitForFunction(()=>window.selectionRuntime.current.id==='session-b');assert.equal(await page.evaluate(()=>window.writes.at(-1).expectedRevision),2,'clearing preserves monotonic optimistic revision');
 // The catalog was replaced without accepting that new digest. Refresh must not fetch it.
 await page.evaluate(()=>{window.catalog[1].digest='b2';window.presentation.refresh();});await page.waitForFunction(()=>document.querySelector('.presentation-controls > [role=status]').textContent.includes('changed'));
 assert.equal(await page.evaluate(()=>window.prepared.includes('session-b:b2')),false);assert.equal(await page.evaluate(()=>window.selectionRuntime.current.digest),'b1');
 await page.getByRole('button',{name:'Apply appearance',exact:true}).click();await page.waitForFunction(()=>window.selectionRuntime.current.digest==='b2');assert.equal(await page.evaluate(()=>window.selection.override.digest),'b2');
 // Returning to an invalid default retains both the current display and the override.
 await page.evaluate(()=>{window.rejectPackage='endpoint-c';});await page.getByRole('button',{name:'Use endpoint default',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.presentation-controls > [role=status]').textContent.includes('Invalid mapped clip'));assert.equal(await page.evaluate(()=>window.selectionRuntime.current.digest),'b2');assert.equal(await page.evaluate(()=>window.selection.override.id),'session-b');
 await page.evaluate(()=>{window.rejectPackage=null;window.selectionBusy=true;});const writes=await page.evaluate(()=>window.writes.length);await page.getByRole('button',{name:'Use endpoint default',exact:true}).click();assert.equal(await page.evaluate(()=>window.writes.length),writes);
 assert.deepEqual(errors,[]);
});
