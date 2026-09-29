import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {ConversationCamera} from '../conversation-camera.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function fixture({configured = true, adapter = true} = {}) {
  let now = 100, visible = true, serverCamera = {revision:0, captureActive:false, leaseId:null};
  let scope = {sessionId:randomUUID(), assistantId:randomUUID(), principalId:randomUUID(), endpointId:randomUUID(), sessionRevision:1};
  const calls = [], operations = [], timers = new Map(), states = [];
  const track = {readyState:'live', stop() { this.readyState = 'ended'; operations.push('track-stop'); }};
  const running = {tracks:[track], stop:() => operations.push('capture-stop'), renew:() => operations.push('capture-renew')};
  const prepared = {sourceLabel:'Synthetic camera', release:() => operations.push('source-release'), start:async() => { operations.push('capture-start'); return running; }};
  const capture = {sourceLabel:'Synthetic camera', prepare:async() => { operations.push('prepare'); return prepared; }};
  const api = async(path, options) => {
    const body = JSON.parse(options.body); calls.push({path, body, options});
    if (path.endsWith('/capabilities')) return {wireProfile:'lifestream.visual-input-http', schemaVersion:'1.0.0', available:configured, reason:configured ? null : 'unconfigured', camera:serverCamera,
      negotiation:{profile:configured ? 'lifestream.conversational-vision.v1' : null, selectedVersion:configured ? '1.0.0' : null,
        implemented:true, configured, providerConnected:configured, sourceConnected:true, mediaTypes:['image/jpeg'],
        challenge:{id:randomUUID(), hostSentMonotonicMs:500000}, bounds:{leaseTtlMs:60000}}};
    operations.push(body.action);
    if (body.action === 'stop') {
      if (serverCamera.leaseId === body.leaseId) serverCamera = {revision:serverCamera.revision + 1, captureActive:false, leaseId:null};
    } else serverCamera = {revision:serverCamera.revision + 1, captureActive:true,
      leaseId:body.action === 'renew' ? serverCamera.leaseId : randomUUID(), clockMappingId:randomUUID(), expiresAtMonotonicMs:560000,
      activeForSession:false, currentObservationUsable:false};
    return {wireProfile:'lifestream.visual-input-http', schemaVersion:'1.0.0', camera:serverCamera};
  };
  const camera = new ConversationCamera({api, scope:() => scope, visible:() => visible, capture:adapter ? capture : null,
    now:() => now, newId:randomUUID, onState:value => states.push(value),
    schedule:(fn, ms) => { const id = randomUUID(); timers.set(id, {fn, ms}); return id; }, cancel:id => timers.delete(id)});
  return {camera, calls, operations, timers, states, track, prepared, capture, running,
    setNow:value => { now = value; }, setVisible:value => { visible = value; }, setScope:value => { scope = {...scope,...value}; },
    server:() => serverCamera};
}

test('construction and availability check never enable, acquire or capture; unsupported peers retain fallback', async() => {
  for (const options of [{configured:false}, {adapter:false}]) {
    const f = fixture(options);
    assert.equal(f.calls.length, 0);
    await f.camera.check();
    assert.equal(f.camera.snapshot.phase, 'unavailable');
    await f.camera.enable();
    assert.equal(f.camera.snapshot.captureActive, false);
    assert.equal(f.calls.every(call => call.path.endsWith('/capabilities')), true);
    assert.deepEqual(f.operations, []);
  }
});

test('legacy, unsupported and mismatched adapters never prepare a camera source', async() => {
  for (const failure of ['legacy404','missingIdentity','wrongIdentity','unsupportedEnvelope','unsupportedNegotiation','unsupportedProfile']) {
    const f = fixture(), base = f.camera.api;
    f.camera.api = async(path, options) => {
      if (failure === 'legacy404') { const error = Error('Camera route unavailable (404).'); error.status = 404; throw error; }
      const value = await base(path, options);
      if (failure === 'missingIdentity') delete value.wireProfile;
      if (failure === 'wrongIdentity') value.wireProfile = 'lifestream.conversational-vision.v1';
      if (failure === 'unsupportedEnvelope') value.schemaVersion = '2.0.0';
      if (failure === 'unsupportedNegotiation') value.negotiation.selectedVersion = '2.0.0';
      if (failure === 'unsupportedProfile') value.negotiation.profile = 'lifestream.visual-input-http';
      return value;
    };
    await f.camera.check(); await f.camera.enable();
    assert.equal(f.camera.snapshot.available, false, failure);
    assert.equal(f.camera.snapshot.captureActive, false, failure);
    assert.deepEqual(f.operations, [], `${failure} must not prepare or grant`);
    assert.equal(f.timers.size, 0, failure);
  }
});

test('missing or wrong camera grant identity cannot start capture or survive renewal', async() => {
  for (const stage of ['enable','renew']) for (const failure of ['missingIdentity','wrongIdentity','unsupportedVersion']) {
    const f = fixture(), base = f.camera.api;
    if (stage === 'renew') await f.camera.enable();
    f.camera.api = async(path, options) => {
      const value = await base(path, options);
      if (JSON.parse(options.body).action === stage) {
        if (failure === 'missingIdentity') delete value.wireProfile;
        if (failure === 'wrongIdentity') value.wireProfile = 'lifestream.conversational-vision.v1';
        if (failure === 'unsupportedVersion') value.schemaVersion = '2.0.0';
      }
      return value;
    };
    if (stage === 'enable') await f.camera.enable();
    else { f.setNow(20100); f.camera.tick(); }
    await flush();
    assert.equal(f.camera.snapshot.captureActive, false, `${stage} ${failure}`);
    assert.equal(f.server().captureActive, false, `${stage} ${failure} exact lease withdrawn`);
    if (stage === 'enable') assert.equal(f.operations.includes('capture-start'), false);
    else assert.equal(f.track.readyState, 'ended');
  }
});

test('enable negotiates before permission and refreshes challenge after preparation; grant precedes local capture', async() => {
  const f = fixture();
  f.capture.prepare = async() => { assert.equal(f.calls.length, 1); f.setNow(10000); f.operations.push('prepare'); return f.prepared; };
  await f.camera.enable();
  assert.deepEqual(f.operations, ['prepare','enable','capture-start']);
  assert.equal(f.calls.length, 3);
  const command = f.calls[2].body;
  assert.equal(command.endpointReceivedMonotonicMs, 10000);
  assert.equal(command.expectedRevision, 0);
  assert.equal(f.camera.lease.expires, 70000, 'browser expiry derives from client monotonic request time');
  assert.equal(f.camera.snapshot.captureActive, true);
  assert.equal(f.camera.snapshot.currentObservationUsable, false, 'lease alone cannot claim seeing');
  await f.camera.stop();
});

test('stop ends tracks and source immediately, then withdraws the exact lease even while network is unavailable', async() => {
  const f = fixture(); await f.camera.enable();
  const id = f.camera.lease.camera.leaseId, response = deferred();
  f.camera.api = async(path, options) => { f.calls.push({path, body:JSON.parse(options.body), options}); return response.promise; };
  const stopping = f.camera.stop();
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.camera.lease, null);
  assert.equal(f.camera.snapshot.captureActive, false);
  assert.equal(f.calls.at(-1).body.leaseId, id);
  assert.equal(f.calls.at(-1).body.action, 'stop');
  assert.equal(f.calls.at(-1).options.keepalive, true);
  response.resolve({}); await stopping;
});

test('late lease grant after stop is withdrawn and cannot start capture', async() => {
  const f = fixture(), grant = deferred(), base = f.camera.api;
  f.camera.api = async(path, options) => {
    const value = await base(path, options);
    return JSON.parse(options.body).action === 'enable' ? grant.promise.then(() => value) : value;
  };
  const enabling = f.camera.enable(); await flush();
  assert.equal(f.server().captureActive, true);
  await f.camera.stop(); grant.resolve(); await enabling; await flush();
  assert.equal(f.operations.includes('capture-start'), false);
  assert.equal(f.server().captureActive, false);
  assert.equal(f.camera.snapshot.phase, 'off');
});

test('late permission or capture completion is disposed after session withdrawal', async() => {
  for (const stage of ['prepare','start']) {
    const f = fixture(), pending = deferred();
    if (stage === 'prepare') f.capture.prepare = () => pending.promise;
    else f.prepared.start = () => pending.promise;
    const enabling = f.camera.enable(); await flush();
    await f.camera.stop(); pending.resolve(stage === 'prepare' ? f.prepared : f.running); await enabling; await flush();
    assert.equal(f.camera.snapshot.captureActive, false);
    assert.ok(f.operations.includes('source-release'));
    if (stage === 'start') assert.equal(f.track.readyState, 'ended');
  }
});

test('hidden, changed scope, ended track, monotonic discontinuity and lease expiry all stop without automatic recovery', async() => {
  for (const cause of ['hidden','scope','track','clock','expiry']) {
    const f = fixture(); await f.camera.enable();
    if (cause === 'hidden') f.setVisible(false);
    if (cause === 'scope') f.setScope({sessionRevision:2});
    if (cause === 'track') f.track.readyState = 'ended';
    if (cause === 'clock') f.setNow(1);
    if (cause === 'expiry') f.setNow(60100);
    f.camera.tick(); await flush();
    assert.equal(f.camera.snapshot.captureActive, false, cause);
    assert.equal(f.track.readyState, 'ended', cause);
    const calls = f.calls.length; f.setVisible(true); f.camera.tick(); await flush();
    assert.equal(f.calls.length, calls, 'restoration never reacquires');
  }
});

test('renewal targets current lease with a new clock challenge; a failed renewal stops capture', async() => {
  const f = fixture(); await f.camera.enable(); const id = f.camera.lease.camera.leaseId;
  f.setNow(20100); f.camera.tick(); await flush();
  assert.equal(f.camera.lease.camera.leaseId, id);
  assert.equal(f.calls.filter(c => c.body.action === 'renew').length, 1);
  assert.equal(f.calls.find(c => c.body.action === 'renew').body.leaseId, id);
  assert.ok(f.operations.includes('capture-renew'));
  f.camera.api = async() => { throw Error('Connection lost'); };
  f.setNow(40100); f.camera.tick(); await flush();
  assert.equal(f.camera.snapshot.captureActive, false);
  assert.equal(f.track.readyState, 'ended');
  assert.match(f.camera.snapshot.message, /Connection lost/);
});

test('frame adapter receives only a granted lease and its usable-state callback is scoped and cleared before renewal', async() => {
  const f = fixture(); let context;
  f.prepared.start = async value => { context=value; return f.running; };
  f.running.suspend = () => f.operations.push('capture-suspend');
  await f.camera.enable();
  assert.equal(context.localExpiresMonotonicMs,f.camera.lease.expires);
  assert.equal(context.api,f.camera.api); assert.equal(context.isCurrent(),true);
  context.onObservation({currentObservationUsable:true});
  assert.equal(f.camera.snapshot.currentObservationUsable,true);
  assert.match(f.camera.snapshot.message,/current visual observation is available/);
  f.setNow(20100); f.camera.tick(); await flush();
  assert.ok(f.operations.indexOf('capture-suspend') < f.operations.indexOf('renew'));
  assert.equal(f.camera.snapshot.currentObservationUsable,false);
  await f.camera.stop();
  context.onObservation({currentObservationUsable:true});
  assert.equal(context.isCurrent(),false);
  assert.equal(f.camera.snapshot.currentObservationUsable,false);
});

test('watchdog stops even when renewal response never arrives', async() => {
  const f = fixture(); await f.camera.enable();
  const pending = deferred(); f.camera.api = () => pending.promise;
  f.setNow(20100); f.camera.tick(); await flush();
  f.setNow(60100); f.camera.tick(); await flush();
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.camera.lease, null);
  pending.resolve({}); await flush();
});

test('permission denial and malformed grant never start a local source', async() => {
  for (const cause of ['permission','grant']) {
    const f = fixture();
    if (cause === 'permission') f.capture.prepare = async() => { throw Error('Camera permission denied'); };
    else {
      const base = f.camera.api;
      f.camera.api = async(path, options) => { const value = await base(path, options); if (JSON.parse(options.body).action === 'enable') value.camera = {...value.camera, clockMappingId:null}; return value; };
    }
    await f.camera.enable(); await flush();
    assert.equal(f.operations.includes('capture-start'), false);
    assert.equal(f.camera.snapshot.captureActive, false);
    assert.equal(f.server().captureActive, false);
  }
});

test('rendered controls keep a persistent camera state and source, stop on navigation and never touch device APIs', {skip:!process.env.PLAYWRIGHT_MODULE}, async t => {
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE), browser = await chromium.launch({channel:'chrome',headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:9/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const body = name ? await readFile(new URL('../' + name, import.meta.url)) : '<link rel="stylesheet" href="/styles.css"><main class="shell"><section class="room-dialogue"></section></main>';
    await route.fulfill({contentType:name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',body});
  });
  await page.goto('http://127.0.0.1:9/#conversation');
  await page.evaluate(async() => {
    navigator.mediaDevices.getUserMedia = () => { throw Error('Physical camera is forbidden in this test'); };
    const {installConversationCamera} = await import('/conversation-camera.js');
    window.cameraRequests = [];
    let lease = {revision:0, captureActive:false, leaseId:null};
    const api = async(path, options) => {
      const body = JSON.parse(options.body); window.cameraRequests.push(body);
      if (!window.syntheticCameraConfigured) return {wireProfile:'lifestream.visual-input-http',schemaVersion:'1.0.0',available:false,reason:'source_unavailable',negotiation:null,camera:lease};
      if (path.endsWith('/camera')) {
        lease = body.action === 'stop' ? {revision:lease.revision + 1,captureActive:false,leaseId:null} :
          {revision:lease.revision + 1,captureActive:true,leaseId:crypto.randomUUID(),clockMappingId:crypto.randomUUID(),expiresAtMonotonicMs:1000000};
        return {wireProfile:'lifestream.visual-input-http',schemaVersion:'1.0.0',camera:lease};
      }
      return {wireProfile:'lifestream.visual-input-http',schemaVersion:'1.0.0',available:true,reason:null,camera:lease,negotiation:{
        profile:'lifestream.conversational-vision.v1',selectedVersion:'1.0.0',implemented:true,configured:true,providerConnected:true,sourceConnected:true,
        mediaTypes:['image/jpeg'],challenge:{id:crypto.randomUUID(),hostSentMonotonicMs:900000},bounds:{leaseTtlMs:60000}}};
    };
    window.camera = installConversationCamera({anchor:document.querySelector('section'),api,scope:() => ({sessionId:crypto.randomUUID(),assistantId:crypto.randomUUID()})});
    window.cameraScope = {sessionId:crypto.randomUUID(),assistantId:crypto.randomUUID()}; window.camera.scope = () => window.cameraScope;
  });
  assert.equal(await page.getByRole('button',{name:'Enable camera',exact:true}).isEnabled(), false);
  await page.getByRole('button',{name:'Check camera availability'}).click();
  await page.waitForFunction(() => document.querySelector('[data-camera-state]').textContent.includes('No camera source'));
  assert.equal(await page.getByRole('button',{name:'Enable camera',exact:true}).isEnabled(), false);
  assert.match(await page.locator('[data-camera-source]').textContent(), /Camera off/);
  assert.equal(await page.evaluate(() => window.cameraRequests.length), 1);
  await page.evaluate(() => {
    window.syntheticCameraConfigured = true; window.captureStarts = 0; window.captureStops = 0;
    window.camera.capture = {sourceLabel:'Synthetic source — no physical camera',prepare:async() => ({
      release:() => {},start:async() => { window.captureStarts++; return {stop:() => { window.captureStops++; }}; }
    })};
  });
  await page.getByRole('button',{name:'Check camera availability'}).click();
  await page.waitForFunction(() => !document.querySelector('[data-camera-enable]').disabled);
  await page.getByRole('button',{name:'Enable camera',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.room-camera').dataset.cameraPhase === 'capturing');
  assert.match(await page.locator('[data-camera-state]').textContent(), /No current visual observation/);
  assert.match(await page.locator('[data-camera-source]').textContent(), /Synthetic source/);
  assert.equal(await page.getByRole('button',{name:'Stop camera',exact:true}).isEnabled(), true);
  if (process.env.LIFESTREAM_CAMERA_SCREENSHOT) await page.screenshot({path:process.env.LIFESTREAM_CAMERA_SCREENSHOT.replace(/\.png$/u,'-capturing.png'),fullPage:true});
  await page.getByRole('button',{name:'Stop camera',exact:true}).click();
  assert.equal(await page.evaluate(() => window.captureStops), 1);
  await page.getByRole('button',{name:'Check camera availability'}).click();
  await page.waitForFunction(() => !document.querySelector('[data-camera-enable]').disabled);
  await page.getByRole('button',{name:'Enable camera',exact:true}).click();
  await page.waitForFunction(() => window.captureStarts === 2);
  await page.evaluate(() => location.hash = '#account');
  await page.waitForFunction(() => document.querySelector('[data-camera-state]').textContent.includes('left the conversation'));
  assert.equal(await page.evaluate(() => window.captureStops), 2);
  const requestCount = await page.evaluate(() => window.cameraRequests.length);
  await page.evaluate(() => location.hash = '#conversation');
  assert.equal(await page.evaluate(() => window.cameraRequests.length), requestCount);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  if (process.env.LIFESTREAM_CAMERA_SCREENSHOT) await page.screenshot({path:process.env.LIFESTREAM_CAMERA_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors, []);
});

test('actual conversation room preserves typed replies and speech connection when a legacy or rolled-back server rejects vision', {skip:!process.env.PLAYWRIGHT_MODULE}, async t => {
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE), browser = await chromium.launch({channel:'chrome',headless:true});
  t.after(() => browser.close());
  for (const failure of ['legacy404','unsupportedVersion']) {
    const page = await browser.newPage({viewport:{width:1280,height:900}}), errors = [], cameraRequests = [], messageRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    const session = {sessionId:randomUUID(),principalId:randomUUID(),csrfToken:'synthetic-csrf'}, assistantId = randomUUID(), relationshipId = randomUUID();
    const endpoint = {endpointId:randomUUID(),privacyClass:'personal',inputModalities:['text','audio'],outputModalities:['text','audio']};
    const stubs = {
      'automatic-memory.js':'export const installAutomaticMemory=()=>({refresh(){}});',
      'incidents.js':'export const installIncidentReview=()=>{};',
      'presentation.js':'export const installPresentation=()=>({state(){},settle(){},clear(){},refresh(){},acceptsSpeech(){return false;}});',
      'acknowledgments.js':'export class AcknowledgmentCache {clear(){} stop(){} async refresh(){} }'
    };
    await page.route('**/*', async route => {
      if (!route.request().url().startsWith('http://127.0.0.1:9/')) return route.abort();
      const name = new URL(route.request().url()).pathname.slice(1), json = (value, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if (name.startsWith('api/runtime/vision/')) {
        cameraRequests.push(JSON.parse(route.request().postData()));
        return failure === 'legacy404' ? json({message:'Camera route unavailable (404).'},404) :
          json({wireProfile:'lifestream.visual-input-http',schemaVersion:'2.0.0',available:false,reason:'unsupported',camera:{revision:0},negotiation:null});
      }
      if (name === 'api/runtime/v1/session-context') return json({revision:1,endpoint,runtimeSelfContext:{audienceScope:'authenticatedSession'}});
      if (name.endsWith('/initiative/v1')) return json({operation:'inspect',records:[],explanations:[]});
      if (name.endsWith('/acknowledgments')) return json({entries:[]});
      if (name === 'api/runtime/v1/messages') {
        messageRequests.push(JSON.parse(route.request().postData()));
        return route.fulfill({contentType:'text/event-stream',body:'event: message.delta\ndata: {"text":"Synthetic ordinary text reply"}\n\nevent: interaction.completed\ndata: {}\n\n'});
      }
      if (!name) return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><main class="shell card"></main></html>'});
      if (!/^[a-z-]+\.(?:js|css)$/u.test(name)) return route.abort();
      return route.fulfill({contentType:name.endsWith('.css') ? 'text/css' : 'text/javascript',body:stubs[name] ?? await readFile(new URL('../' + name, import.meta.url))});
    });
    await page.addInitScript(({session, assistantId, relationshipId}) => {
      window.lifestreamAuth = {mode:'local-password',session,ready:Promise.resolve()};
      window.roomIdentity = {assistantId,displayName:'Synthetic Assistant',relationship:{relationshipId}};
      window.audioResumes = 0; window.deviceCalls = 0; window.sockets = [];
      navigator.mediaDevices.getUserMedia = () => { window.deviceCalls++; throw Error('Physical IO is forbidden'); };
      window.AudioContext = class extends EventTarget {
        constructor() { super(); this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
        async resume() { this.state = 'running'; window.audioResumes++; }
        async close() { this.state = 'closed'; }
      };
      window.WebSocket = class extends EventTarget {
        static OPEN = 1;
        constructor(url) { super(); this.url = url; this.readyState = 0; window.sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
        send() {}
        close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
      };
    }, {session, assistantId, relationshipId});
    await page.goto('http://127.0.0.1:9/#conversation');
    await page.evaluate(async() => {
      const {installConversationRoom} = await import('/conversation-room.js');
      const api = async(path, options) => { const response = await fetch(path, options), value = await response.json(); if (!response.ok) throw Error(value.message); return value; };
      installConversationRoom({anchor:document.querySelector('main'),api,context:() => window.roomIdentity});
    });
    await page.waitForFunction(() => document.querySelector('#room-disclosure').textContent.startsWith('Session revision 1'));
    await page.locator('#room-modality').selectOption('speech');
    await page.locator('#room-enable').click();
    await page.waitForFunction(() => document.querySelector('#room-output-state').textContent.startsWith('Speech ready'));
    await page.getByRole('button',{name:'Check camera availability'}).click();
    await page.waitForFunction(() => document.querySelector('.room-camera').dataset.cameraPhase === 'unavailable');
    assert.equal(await page.getByRole('button',{name:'Enable camera',exact:true}).isEnabled(), false);
    assert.match(await page.locator('#room-output-state').textContent(), /^Speech ready/u, failure);
    assert.equal(await page.evaluate(() => window.sockets.at(-1).readyState), 1, failure);
    await page.locator('#room-message').fill('Synthetic ordinary message');
    await page.locator('#room-send').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.room-turn-state')].some(node => node.textContent === 'Completed'));
    assert.equal(messageRequests.length, 1, failure);
    assert.equal(messageRequests[0].userInput, 'Synthetic ordinary message');
    assert.match(await page.locator('#room-turns').textContent(), /Synthetic ordinary text reply/u);
    await page.locator('#room-enable').click();
    await page.waitForFunction(() => document.querySelector('#room-output-state').textContent.startsWith('Speech ready'));
    assert.equal(await page.evaluate(() => window.sockets.at(-1).url.endsWith('/api/runtime/v1/audio')), true);
    assert.equal(await page.evaluate(() => window.audioResumes), 2);
    assert.equal(await page.evaluate(() => window.deviceCalls), 0);
    assert.equal(cameraRequests.length, 1, 'camera failure cannot trigger retry or grant');
    assert.deepEqual(errors, []);
    await page.close();
  }
});
