import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname} from 'node:path';
import {startInitiativeReview} from '../../../scripts/start-initiative-review.mjs';

async function client(review){
 const credentials=JSON.parse(await readFile(review.credentialsPath,'utf8')),response=await fetch(review.base+'/api/auth/v1/sign-in',{method:'POST',headers:{origin:review.base,'content-type':'application/json'},body:JSON.stringify(credentials)});assert.equal(response.status,200);const {session}=await response.json(),headers={origin:review.base,'content-type':'application/json',cookie:response.headers.get('set-cookie').split(';')[0],'x-lifestream-csrf':session.csrfToken};
 return {session,send:async(path,body)=>{const r=await fetch(review.base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}};
}
async function host(t){const review=await startInitiativeReview();t.after(async()=>{await review.close();await rm(review.directory,{recursive:true,force:true});});return review;}

test('fresh review host uses protected setup and explicit scoped preparation without capture, output or profile fallback',async t=>{
 await assert.rejects(startInitiativeReview({providerProfile:'mac-local'}),/explicitly/u);
 const review=await host(t),other=await host(t);assert.notEqual(review.directory,other.directory);assert.equal((await stat(review.directory)).mode&0o777,0o700);assert.equal((await stat(review.credentialsPath)).mode&0o777,0o600);assert.deepEqual(review.sessions(),[]);assert.throws(()=>review.prepare(randomUUID()),/current browser session/u);
 let calls=0;review.app.providers.inference={async *generate(){calls++;yield {kind:'text',text:'Synthetic isolated host opening.'};yield {kind:'done'};}};
 const c=await client(review),foreign=await client(other),path=`/api/admin/v1/assistants/${review.scope.assistantId}/relationships/${review.scope.relationshipId}/initiative/v1`,request=body=>c.send(path,{schemaVersion:'1.0.0',...body});
 await c.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});assert.equal(review.sessions().length,1);assert.equal((await c.send('/api/runtime/v1/profile',{profile:'ai5090'})).status,409);assert.equal(review.app.config.profile,'test');await review.configure(c.session.sessionId);assert.equal(calls,0);
 assert.throws(()=>review.prepare(foreign.session.sessionId),/current browser session/u);assert.throws(()=>review.prepare(c.session.sessionId,'arbitrary','text'),/supported synthetic/u);
 const prepared=review.prepare(c.session.sessionId),inspect=await request({operation:'inspect'});assert.equal(inspect.status,200);assert.ok(inspect.body.explanations.some(e=>e.sourceRefs.includes(prepared.sourceEventId)));assert.equal(calls,0);assert.equal(inspect.body.delivery,null);
 const simulate={operation:'simulate',sessionId:c.session.sessionId,sourceEventId:prepared.sourceEventId,kind:prepared.kind,topicRef:null,idempotencyKey:randomUUID()};
 const unready=await request(simulate);assert.equal(unready.body.records.find(r=>r.recordType==='outcome').state,'suppressed');assert.equal(calls,0);
 await request({operation:'outputReadiness',sessionId:c.session.sessionId,modality:'text',ready:true});const next=review.prepare(c.session.sessionId,'groundedFollowUp');const info=(await request({operation:'inspect'})).body.explanations.find(e=>e.sourceRefs[0]===next.sourceEventId);
 const result=await request({...simulate,sourceEventId:next.sourceEventId,kind:next.kind,topicRef:info.sourceRefs[1],idempotencyKey:randomUUID()});assert.equal(result.status,200);assert.equal(result.body.delivery?.text,'Synthetic isolated host opening.');assert.equal(calls,1);
 for(let n=0;n<126;n++)review.prepare(c.session.sessionId);assert.throws(()=>review.prepare(c.session.sessionId),/capacity/u);assert.equal(calls,1);
 await c.send('/api/auth/v1/sign-out',{});assert.deepEqual(review.sessions(),[]);assert.throws(()=>review.prepare(c.session.sessionId),/current browser session/u);await review.close();assert.throws(()=>review.prepare(c.session.sessionId),/closed/u);
});

test('a fresh browser signs in, chooses disclosure and runs a host-prepared case through the first-party picker',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:45000},async t=>{
 const review=await host(t),{chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const credentials=JSON.parse(await readFile(review.credentialsPath,'utf8'));await page.goto(review.url);await page.waitForFunction(()=>!!window.lifestreamUI);await page.locator('#auth-username').fill(credentials.username);await page.locator('#auth-password').fill(credentials.password);await page.locator('#auth-sign-in').click();await page.waitForFunction(()=>!!window.lifestreamAuth.session);
 await page.locator('[data-destination="session"]').click();await page.locator('#session-audience').selectOption('authenticatedSession');await page.locator('#session-context-apply').click();await page.locator('#session-context-status').filter({hasText:'Approved context allowed'}).waitFor();
 const [session]=review.sessions();assert.ok(session);await review.configure(session.sessionId);review.prepare(session.sessionId,'arrivalReturn','text');
 await page.locator('[data-destination="conversation"]').click();await page.locator('#room-refresh').click();await page.locator('.room-simulation > summary').click();await page.locator('#room-sources-refresh').click();await page.locator('#room-case option').filter({hasText:'Arrival or return'}).waitFor({state:'attached'});await page.locator('#room-case').selectOption({index:1});await page.locator('#room-case-enable').click();await page.locator('#room-case-output-status').filter({hasText:'Text openings ready'}).waitFor();await page.locator('#room-run').click();await page.locator('.room-turn-state').filter({hasText:'Endpoint accepted'}).waitFor();
 assert.equal(await page.locator('.room-turn.user').count(),0);assert.equal(await page.locator('.room-turn.assistant').count(),1);assert.deepEqual(errors,[]);
});


test('standalone launcher prints only its private credential path and quits its owned service',{timeout:15000},async t=>{
 const child=spawn(process.execPath,['scripts/start-initiative-review.mjs'],{stdio:['pipe','pipe','pipe']}),chunks=[];let sent=false;const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
 child.stdout.on('data',chunk=>{chunks.push(chunk.toString());if(!sent&&chunks.join('').includes('Commands:')){sent=true;child.stdin.end('sessions\nquit\n');}});child.stderr.on('data',()=>{});
 assert.equal(await done,0);const output=chunks.join(''),credentialsPath=output.match(/Private credentials file: ([^\n]+)/u)?.[1],url=output.match(/Synthetic review: (http:\/\/[^\n]+)/u)?.[1];assert.ok(credentialsPath);t.after(()=>rm(dirname(credentialsPath),{recursive:true,force:true}));
 const credentials=JSON.parse(await readFile(credentialsPath,'utf8'));assert.equal(output.includes(credentials.password),false);assert.match(output,/fixture responses/u);assert.match(output,/No eligible browser sessions/u);await assert.rejects(fetch(url));
});
