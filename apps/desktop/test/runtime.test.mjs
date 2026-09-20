import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
test('native offline retry recovers the selected endpoint and preserves sandbox and origin guard',{skip:!process.env.PLAYWRIGHT_MODULE||process.platform!=='darwin',timeout:60000},async()=>{
 const {_electron}=await import(process.env.PLAYWRIGHT_MODULE),profile=await mkdtemp(join(tmpdir(),'lifestream-native-test-')),electron=createRequire(import.meta.url)('electron');
 let deniedRequests=0;const denied=createServer((_req,res)=>{deniedRequests++;res.end('denied');});await new Promise(r=>denied.listen(0,'127.0.0.1',r));const deniedPort=denied.address().port;
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><h1>Synthetic local core</h1><p>No provider, microphone or camera.</p>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const endpoint=`http://127.0.0.1:${port}/control/#account`,executable=process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE??electron,args=process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE?[]:[resolve(import.meta.dirname,'../main.cjs')];
 const app=await _electron.launch({executablePath:executable,args:[...args,'--url',endpoint,'--user-data-dir='+profile,'--diagnostic']});
 try{const page=await app.firstWindow();page.setDefaultTimeout(10000);await page.getByRole('heading',{name:'The local server is unavailable'}).waitFor();assert.equal(await page.getByRole('link',{name:'Retry connection'}).getAttribute('href'),endpoint);assert.equal(await page.evaluate(()=>typeof require),'undefined');assert.equal(await page.locator('script').count(),0);
 if(process.env.LIFESTREAM_NATIVE_PROOF_DIRECTORY)await page.screenshot({path:join(process.env.LIFESTREAM_NATIVE_PROOF_DIRECTORY,'native-offline.png')});
 const security=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));await page.getByRole('link',{name:'Retry connection'}).click();await page.getByRole('heading',{name:'Synthetic local core'}).waitFor();assert.equal(page.url(),endpoint);assert.deepEqual(await page.evaluate(()=>Object.keys(window.lifestreamDesktop)),['onPrivacyLock']);
 const result=await page.evaluate(async port=>{try{await fetch('http://127.0.0.1:'+port+'/');return 'unexpected';}catch{return 'denied';}},deniedPort);assert.equal(result,'denied');assert.equal(deniedRequests,0);
 await new Promise(r=>server.close(r));await page.reload().catch(()=>{});await page.getByRole('heading',{name:'The local server is unavailable'}).waitFor();await new Promise(r=>server.listen(port,'127.0.0.1',r));await page.getByRole('link',{name:'Retry connection'}).click();await page.getByRole('heading',{name:'Synthetic local core'}).waitFor();assert.equal(page.url(),endpoint);
 }finally{await app.close();if(server.listening)await new Promise(r=>server.close(r));await new Promise(r=>denied.close(r));await rm(profile,{recursive:true,force:true});}
});
