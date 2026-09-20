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
