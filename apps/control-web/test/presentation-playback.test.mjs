import assert from 'node:assert/strict';
import test from 'node:test';
import {ConversationOutput} from '../conversation-output.js';
import {readFile} from 'node:fs/promises';
import {presentationVendor} from '../../server/src/runtime/presentation-vendor.ts';
test('mouth sampling follows scheduled PCM, becomes silent in a gap and cannot sample a stopped trace',t=>{
 const original=globalThis.WebSocket;globalThis.WebSocket={OPEN:1};t.after(()=>{globalThis.WebSocket=original;});
 const output=new ConversationOutput({onStopped:()=>{},onState:()=>{},onComplete:()=>{}});let stopped=0;
 output.socket={readyState:1,send:()=>{}};output.audio={state:'running',currentTime:0,destination:{},createBuffer:(_channels,n)=>{const samples=new Float32Array(n);return {duration:n/48000,getChannelData:()=>samples};},createBufferSource:()=>({connect(){},disconnect(){},addEventListener(){},start(){},stop(){stopped++;}})};
 output.turn={trace:'synthetic-trace',stopped:false};const samples=new Uint8Array(9600),view=new DataView(samples.buffer);for(let i=0;i<4800;i++)view.setInt16(i*2,16384,true);output.play(samples);assert.equal(output.playbackSample().playing,false);
 output.audio.currentTime=.26;const playing=output.playbackSample();assert.equal(playing.playing,true);assert.equal(playing.trace,'synthetic-trace');assert.ok(Math.abs(playing.amplitude-.5)<.001);assert.ok(playing.sampleOffset>=479&&playing.sampleOffset<=481);
 output.audio.currentTime=.36;assert.equal(output.playbackSample().playing,false);output.play(samples);output.stop();assert.equal(output.playbackSample().playing,false);assert.equal(output.playbackFrames.length,0);assert.ok(stopped>=1);
});
test('a failed GLTF texture rejects the replacement and releases its package URLs',{skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('http://127.0.0.1:9/**',async route=>{
  const name=new URL(route.request().url()).pathname.slice(1);
  if(!name)return route.fulfill({contentType:'text/html',body:'<script type="importmap">{"imports":{"three":"/three.module.js"}}</script>'});
  const body=name==='presentation-runtime.js'?await readFile(new URL('../presentation-runtime.js',import.meta.url)):await presentationVendor(name);
  if(!body)return route.abort();return route.fulfill({contentType:'text/javascript',body});
 });await page.goto('http://127.0.0.1:9/');
 const result=await page.evaluate(async()=>{
  const {PresentationRuntime}=await import('/presentation-runtime.js');
  const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],buffers:[{uri:'mesh.bin',byteLength:60}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],textures:[{source:0}],images:[{uri:'texture.png'}]};
  const canvas=document.createElement('canvas');canvas.width=canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);const png=await new Promise(resolve=>canvas.toBlob(resolve));
  const files=new Map([['model.gltf',new TextEncoder().encode(JSON.stringify(gltf))],['mesh.bin',new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1,0,0,1])],['texture.png',new Uint8Array(await png.arrayBuffer())]]);
  const runtime=Object.create(PresentationRuntime.prototype),prior={label:'prior'};runtime.current=prior;
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),created=[],revoked=[];URL.createObjectURL=value=>{const url=create(value);created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);return revoke(url);};
  const nativeFetch=window.fetch;window.fetch=(url,options)=>String(url).startsWith('/api/runtime/v1/presentation/resources/')?Promise.resolve(new Response(files.get(String(url).split('/').pop()))):nativeFetch(url,options);
  const item=async()=>({id:'synthetic',label:'synthetic',manifest:{model:'model.gltf',animations:{},resources:await Promise.all([...files].map(async([path,data])=>({path,bytes:data.byteLength,mime:path.endsWith('.png')?'image/png':'application/octet-stream',sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('')})))}});
  const loaded=await runtime.prepare(await item());let textureLoaded=false;loaded.root.traverse(node=>{if(node.material?.map?.source?.data?.width===2)textureLoaded=true;});runtime.release(loaded);
  const before=created.length;files.set('texture.png',new Uint8Array([0,1,2,3]));let failure='';try{await runtime.prepare(await item());}catch(error){failure=error.message;}
  return {textureLoaded,failure,priorRetained:runtime.current===prior,failedUrlsReleased:created.slice(before).every(url=>revoked.includes(url)),failedUrlCount:created.length-before};
 });
 assert.equal(result.textureLoaded,true);assert.match(result.failure,/texture could not be loaded/);assert.equal(result.priorRetained,true);assert.equal(result.failedUrlsReleased,true);assert.equal(result.failedUrlCount,3);
});
