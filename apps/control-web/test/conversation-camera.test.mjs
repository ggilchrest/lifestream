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
    if (path.endsWith('/capabilities')) return {schemaVersion:'1.0.0', available:configured, reason:configured ? null : 'unconfigured', camera:serverCamera,
      negotiation:{profile:configured ? 'lifestream.conversational-vision.v1' : null, selectedVersion:configured ? '1.0.0' : null,
        implemented:true, configured, providerConnected:configured, sourceConnected:true, mediaTypes:['image/jpeg'],
        challenge:{id:randomUUID(), hostSentMonotonicMs:500000}, bounds:{leaseTtlMs:60000}}};
    operations.push(body.action);
    if (body.action === 'stop') {
      if (serverCamera.leaseId === body.leaseId) serverCamera = {revision:serverCamera.revision + 1, captureActive:false, leaseId:null};
    } else serverCamera = {revision:serverCamera.revision + 1, captureActive:true,
      leaseId:body.action === 'renew' ? serverCamera.leaseId : randomUUID(), clockMappingId:randomUUID(), expiresAtMonotonicMs:560000,
      activeForSession:false, currentObservationUsable:false};
    return {schemaVersion:'1.0.0', camera:serverCamera};
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
      if (!window.syntheticCameraConfigured) return {schemaVersion:'1.0.0',available:false,reason:'source_unavailable',negotiation:null,camera:lease};
      if (path.endsWith('/camera')) {
        lease = body.action === 'stop' ? {revision:lease.revision + 1,captureActive:false,leaseId:null} :
          {revision:lease.revision + 1,captureActive:true,leaseId:crypto.randomUUID(),clockMappingId:crypto.randomUUID(),expiresAtMonotonicMs:1000000};
        return {schemaVersion:'1.0.0',camera:lease};
      }
      return {schemaVersion:'1.0.0',available:true,reason:null,camera:lease,negotiation:{
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
