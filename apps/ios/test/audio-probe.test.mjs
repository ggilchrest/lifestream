import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {inspectProbeWav} from '../scripts/generate-audio-probe.mjs';
import {bundleWeb} from '../scripts/build-web.mjs';

function wav(samples=48000){
 const b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;
}
test('offline probe accepts short and 15-second PCM16 clips with exact bounds',()=>{
 for(const samples of [1,48000,720000])assert.deepEqual(inspectProbeWav(wav(samples)),{sampleRateHz:48000,channels:1,encoding:'pcm_s16le',samples,durationSeconds:samples/48000,bytes:44+samples*2});
});
test('offline probe rejects malformed containers, wrong PCM format, empty and long clips',()=>{
 for(const invalid of [Buffer.alloc(43),wav(0),wav(720001),wav().subarray(0,100),Buffer.alloc(2*1024*1024+1)])assert.throws(()=>inspectProbeWav(invalid));
 for(const [offset,value,width] of [[20,3,2],[22,2,2],[24,44100,4],[28,192000,4],[32,4,2],[34,32,2],[40,999999,4]]){
  const b=wav();width===4?b.writeUInt32LE(value,offset):b.writeUInt16LE(value,offset);assert.throws(()=>inspectProbeWav(b));
 }
});
test('local audio UI requires an explicit action, stops on Settings, and renders safe test state',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-audio-probe-ui-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const web=join(root,'web');await mkdir(web);const entry=join(root,'entry.js');
 await writeFile(entry,`import {installApp} from ${JSON.stringify(new URL('../web/controller.js',import.meta.url).pathname)};
 let listener;window.calls=[];window.requests=[];window.copies=[];window.emit=message=>listener(message);
 installApp({restoreConnection:async()=>({hasSession:false,authState:'needsSignIn'}),addListener:async(_,fn)=>{listener=fn},request:async value=>{window.requests.push(value);throw Error('No server in local test')},snapshot:async()=>({active:false}),cancelText:async()=>{},copyAudioDiagnostics:async(...args)=>{window.copies.push(args);return {copied:true};},
 startAudioProbe:async({mode})=>{window.calls.push(mode);listener({type:'state',state:{active:false,phase:'Conversation stopped for the local audio test'}});listener({type:'audioProbe',active:true,mode,status:mode==='media'?'Microphone is off.':'Microphone and echo processing on.',diagnostics:'output=Speaker · session=48000Hz'});},
 stopAudioProbe:async()=>{window.calls.push('stopProbe');listener({type:'audioProbe',active:false,status:'Local test stopped. Microphone and playback are off.',diagnostics:'output=Speaker · session=48000Hz'});},
 stop:async()=>{window.calls.push('stop');listener({type:'audioProbe',active:false,status:'Stopped',diagnostics:''});return {active:false};}});`);
 await bundleWeb({entryPoints:[entry],outfile:join(web,'app.js')});for(const file of ['index.html','app.css'])await copyFile(new URL('../web/'+file,import.meta.url),join(web,file));
 const server=createServer(async(req,res)=>{try{const name=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','app.css','app.js'].includes(name)){res.writeHead(404).end();return}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(join(web,name)));}catch{res.writeHead(500).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#status').filter({hasText:'Connect to'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);assert.deepEqual(await page.evaluate(()=>window.copies),[],'clipboard is untouched without a button tap');assert.equal(await page.locator('#probe-stop').isDisabled(),true);
 await page.locator('#open-settings').click();await page.getByText('Advanced & Diagnostics',{exact:true}).click();await page.locator('#audio-diagnostics summary').click();await page.locator('#probe-media').click();assert.equal(await page.locator('#probe-stop').isDisabled(),false);assert.match(await page.locator('#probe-status').innerText(),/Microphone is off/);
 await page.locator('#probe-conversation').click();assert.match(await page.locator('#probe-status').innerText(),/echo processing on/);assert.equal(await page.locator('#input-status').innerText(),'Test mic (no capture)');assert.equal(await page.locator('#stop').isDisabled(),false);
 await page.locator('#probe-stop').click();assert.equal(await page.locator('#probe-stop').isDisabled(),true);
 await page.locator('#probe-media').click();await page.locator('#close-settings').click();assert.equal(await page.locator('#settings-pane').isVisible(),false);assert.equal(await page.locator('#probe-stop').isDisabled(),true);
 await page.locator('#open-settings').click();await page.locator('#probe-conversation').click();await page.locator('#probe-stop').click();assert.equal(await page.locator('#probe-stop').isDisabled(),true);
 await page.evaluate(()=>window.emit({type:'audioProbe',active:false,status:'<script>unsafe</script>',diagnostics:'<img src=x onerror=unexpected()>'}));assert.equal(await page.locator('#probe-detail img').count(),0);assert.match(await page.locator('#probe-detail').innerText(),/img src/);
 assert.deepEqual(await page.evaluate(()=>window.copies),[],'playback and diagnostic events never copy automatically');
 await page.locator('#copy-audio-diagnostics').click();assert.deepEqual(await page.evaluate(()=>window.copies),[[]],'explicit copy requests native metadata without forwarding displayed text');assert.match(await page.locator('#diagnostics-copy-status').textContent(),/Diagnostics copied.*5 minutes/);
 await page.evaluate(()=>window.emit({type:'state',state:{active:false,phase:'Fresh state',route:'PRIVATE DEVICE NAME',captureDiagnostics:['session=48000Hz']}}));assert.match(await page.locator('#diagnostics-copy-status').textContent(),/Diagnostics copied/,'native refresh does not erase copy confirmation');assert.deepEqual(await page.evaluate(()=>window.copies),[[]]);
 assert.deepEqual(await page.evaluate(()=>window.calls),['media','conversation','stopProbe','media','stopProbe','conversation','stopProbe']);assert.deepEqual(await page.evaluate(()=>window.requests),[]);assert.deepEqual(errors,[]);
});
