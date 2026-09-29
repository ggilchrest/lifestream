const VERSION = '1.0.0';
// This HTTP adapter envelope is distinct from the internal perception profile.
const WIRE_PROFILE = 'lifestream.visual-input-http';
const PROFILE = 'lifestream.conversational-vision.v1';
const PURPOSE = 'Visible context for this conversation';
const reasons = {
  source_unavailable: 'No camera source is connected to this session.',
  unconfigured: 'Visual interpretation is not configured.',
  unsupported: 'This service does not support conversational vision.',
  provider_unavailable: 'Visual interpretation is unavailable.',
  capture_unconfigured: 'A browser camera source and capture broker are not configured.'
};
const finite = value => Number.isFinite(value) && value >= 0;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const supportedEnvelope = value => value?.wireProfile === WIRE_PROFILE && value.schemaVersion === VERSION;
const disposedHandles = new WeakSet();
const stopHandle = handle => {
  if (!handle || typeof handle !== 'object' || disposedHandles.has(handle)) return;
  disposedHandles.add(handle);
  // Tracks are stopped locally even if the adapter's cleanup fails.
  for (const track of handle?.tracks ?? []) { try { track.stop(); } catch { /* Stop the remaining tracks too. */ } }
  try { handle?.stop?.(); } catch { /* Remote expiry still bounds the lease. */ }
  try { handle?.release?.(); } catch { /* Never restore capture after cleanup failure. */ }
};

/**
 * Session camera lifecycle. There is deliberately no default capture adapter.
 * A composition adapter must bind the host source to the browser source, obtain
 * permission/broker authority in prepare without capturing, and start only once
 * a host lease exists, returning fresh single-use handles. It owns bounded frame
 * ingress and all ephemeral buffers.
 * Synthetic adapters qualify this lifecycle; they do not qualify physical IO.
 */
export class ConversationCamera {
  constructor({api, scope, visible = () => !document.hidden, capture = null,
    onState = () => {}, now = () => performance.now(), newId = () => crypto.randomUUID(),
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer)}) {
    Object.assign(this, {api, scope, visible, capture, onState, now, newId, schedule, cancel});
    this.generation = 0;
    this.clockId = newId();
    this.snapshot = {phase:'off', message:'Camera off. Check availability before enabling it.', source:'No camera source configured', purpose:PURPOSE, captureActive:false, currentObservationUsable:false, available:false};
    this.emit();
  }

  emit(values = {}) { this.snapshot = {...this.snapshot, ...values}; this.onState({...this.snapshot}); }
  current(scope, generation) {
    try { return this.generation === generation && this.visible() && JSON.stringify(this.scope()) === JSON.stringify(scope); } catch { return false; }
  }
  path(scope, operation) { return `/api/runtime/vision/v1/sessions/${encodeURIComponent(scope.sessionId)}/${operation}`; }
  post(scope, operation, value, options = {}) {
    return this.api(this.path(scope, operation), {method:operation === 'camera' ? 'PUT' : 'POST', ...options,
      body:JSON.stringify({schemaVersion:VERSION, assistantId:scope.assistantId, ...value})});
  }
  async negotiate(scope) {
    const sent = this.now();
    const value = await this.post(scope, 'capabilities', {supportedVersions:[VERSION]});
    const received = this.now(), n = value?.negotiation;
    if (!supportedEnvelope(value) || !revision(value?.camera?.revision)) throw Error('The service returned an unsupported camera response. Text and audio remain available.');
    const valid = value.available === true && n?.profile === PROFILE && n.selectedVersion === VERSION &&
      n.implemented === true && n.configured === true && n.providerConnected === true && n.sourceConnected === true &&
      n.mediaTypes?.some(type => ['image/jpeg','image/png'].includes(type)) && uuid(n.challenge?.id) &&
      finite(n.challenge.hostSentMonotonicMs) && finite(n.bounds?.leaseTtlMs) && n.bounds.leaseTtlMs > 0 && n.bounds.leaseTtlMs <= 60000;
    return {value, sent, received, valid};
  }
  unavailable(result) {
    const reason = !result.valid ? result.value.reason ?? 'unsupported' : 'capture_unconfigured';
    this.emit({phase:'unavailable', available:false, captureActive:false, currentObservationUsable:false,
      message:reasons[reason] ?? 'Camera unavailable. Text and audio remain available.',
      negotiated:result.value.negotiation?.selectedVersion ?? null,
      source:this.capture?.sourceLabel ?? 'No camera source configured'});
  }
  async check() {
    if (this.operation || this.lease) return;
    const generation = this.generation;
    this.emit({phase:'checking', available:false, message:'Checking camera availability…'});
    this.operation = 'check';
    try {
      const scope = this.scope();
      if (!this.current(scope, generation)) throw Error('Open this conversation in the foreground first.');
      const result = await this.negotiate(scope);
      if (!this.current(scope, generation)) return;
      if (!result.valid || !this.capture) return this.unavailable(result);
      this.emit({phase:'off', available:true, negotiated:VERSION, source:this.capture.sourceLabel,
        message:'Camera off. Enable camera to request permission for this session.'});
    } catch (error) { if (generation === this.generation) this.emit({phase:'unavailable', available:false, message:error.message}); }
    finally { if (generation === this.generation) { this.operation = null; this.emit(); } }
  }
  async enable() {
    if (this.operation || this.lease) return;
    const generation = ++this.generation;
    let prepared, granted, scope;
    this.operation = 'enable';
    this.abort = new AbortController();
    this.emit({phase:'requesting', available:false, captureActive:false, currentObservationUsable:false, message:'Requesting camera permission and a session lease…'});
    try {
      scope = this.scope();
      if (!this.current(scope, generation)) throw Error('Open this conversation in the foreground first.');
      // Probe before any permission or capture operation. Negotiation alone is
      // never a source binding, device permission or host broker authorization.
      const probe = await this.negotiate(scope);
      if (!this.current(scope, generation)) return;
      if (!probe.valid || !this.capture) return this.unavailable(probe);
      prepared = await this.capture.prepare({scope, negotiation:probe.value.negotiation, signal:this.abort.signal});
      if (!this.current(scope, generation)) return;
      if (!prepared || typeof prepared.start !== 'function' || typeof prepared.release !== 'function') throw Error('Camera source preparation is unavailable.');
      this.prepared = prepared;
      // Permission may take minutes; consume a new short-lived challenge only
      // after the adapter has completed permission and source preparation.
      const ready = await this.negotiate(scope);
      if (!this.current(scope, generation)) return;
      if (!ready.valid) throw Error(reasons[ready.value.reason] ?? 'Camera became unavailable.');
      granted = (await this.command(scope, 'enable', ready)).camera;
      if (!this.current(scope, generation)) return;
      this.acceptLease(scope, granted, ready, generation);
      const running = await prepared.start({scope, lease:granted, negotiation:ready.value.negotiation,
        endpointClockId:this.clockId, signal:this.abort.signal,api:this.api,localExpiresMonotonicMs:this.lease.expires,
        isCurrent:() => this.current(scope,generation),
        onObservation:value => {
          if (!this.current(scope,generation) || !this.lease) return;
          const usable = value.currentObservationUsable === true;
          this.emit({currentObservationUsable:usable,message:usable ? 'Camera capturing. A current visual observation is available.' : 'Camera capturing. No current visual observation has been confirmed.'});
        },
        onEnded:message => { if (this.current(scope, generation)) void this.stop(message || 'Camera source disconnected. Enable it again to retry.'); }});
      if (!this.current(scope, generation) || !this.lease) { stopHandle(running); return; }
      if (!running || typeof running.stop !== 'function') throw Error('Camera source did not start.');
      this.running = running;
      this.emit({phase:'capturing', source:prepared.sourceLabel ?? this.capture.sourceLabel,
        captureActive:true, currentObservationUsable:false, message:'Camera capturing. No current visual observation has been confirmed.'});
    } catch (error) {
      if (generation === this.generation) await this.stop(error.message);
    } finally {
      if (generation !== this.generation || !this.lease) {
        if (this.prepared === prepared) this.prepared = null;
        stopHandle(prepared);
        if (granted?.leaseId && scope) void this.withdraw(scope, granted);
      }
      if (generation === this.generation) { this.operation = null; this.emit(); }
    }
  }
  async command(scope, action, negotiated, lease = null) {
    const result = await this.post(scope, 'camera', {action, expectedRevision:negotiated.value.camera.revision,
      idempotencyKey:this.newId(), ...(lease ? {leaseId:lease.leaseId} : {}),
      challengeId:negotiated.value.negotiation.challenge.id, endpointClockId:this.clockId,
      endpointReceivedMonotonicMs:negotiated.received});
    if (!supportedEnvelope(result)) {
      void this.withdraw(scope, result?.camera);
      throw Error('The service returned an unsupported camera grant.');
    }
    return result;
  }
  acceptLease(scope, lease, negotiated, generation) {
    if (!revision(lease?.revision) || !uuid(lease.leaseId) || !uuid(lease.clockMappingId) || lease.captureActive !== true || !finite(lease.expiresAtMonotonicMs)) throw Error('The camera lease was not accepted.');
    const ttl = Math.min(negotiated.value.negotiation.bounds.leaseTtlMs,
      lease.expiresAtMonotonicMs - negotiated.value.negotiation.challenge.hostSentMonotonicMs);
    // Client request-send + TTL expires no later than host enable-receipt + TTL.
    // A host monotonic timestamp is never compared directly to a browser clock.
    const expires = negotiated.sent + ttl;
    if (this.now() >= expires) throw Error('The camera lease expired before capture could start.');
    this.lease = {scope, camera:lease, generation, expires, renewAt:this.now() + Math.min(20000, ttl / 3)};
    this.lastTick = this.now();
    this.cancel(this.timer);
    this.timer = this.schedule(() => this.tick(), Math.min(250, expires - this.now()));
  }
  tick() {
    const lease = this.lease;
    if (!lease) return;
    const now = this.now();
    if (!this.current(lease.scope, lease.generation)) return void this.stop('Camera stopped because the session or foreground changed.');
    if (now < this.lastTick || now >= lease.expires) return void this.stop('Camera lease expired. Enable camera again to continue.');
    this.lastTick = now;
    if (this.running?.tracks?.some(track => track.readyState === 'ended')) return void this.stop('Camera permission or source was lost. Enable it again to retry.');
    if (now >= lease.renewAt && !this.renewing) void this.renew(lease);
    this.timer = this.schedule(() => this.tick(), Math.min(250, lease.expires - now));
  }
  async renew(lease) {
    this.renewing = lease;
    try {
      // Pause ingress and invalidate observations before the host changes its
      // clock mapping. The adapter must let existing HTTP responses settle.
      this.running?.suspend?.();
      this.emit({currentObservationUsable:false,message:'Camera capturing. Refreshing session authorization…'});
      const ready = await this.negotiate(lease.scope);
      if (this.lease !== lease || !this.current(lease.scope, lease.generation)) return;
      if (!ready.valid || ready.value.camera.leaseId !== lease.camera.leaseId) throw Error('Camera authorization is no longer current.');
      const camera = (await this.command(lease.scope, 'renew', ready, lease.camera)).camera;
      if (this.lease !== lease || !this.current(lease.scope, lease.generation)) { void this.withdraw(lease.scope, camera); return; }
      this.acceptLease(lease.scope, camera, ready, lease.generation);
      await this.running?.renew?.({lease:camera, negotiation:ready.value.negotiation,localExpiresMonotonicMs:this.lease.expires});
      this.emit({currentObservationUsable:false,message:'Camera capturing. No current visual observation has been confirmed.'});
    } catch (error) { if (this.lease === lease || this.current(lease.scope, lease.generation)) await this.stop(error.message); }
    finally { if (this.renewing === lease) this.renewing = false; }
  }
  async withdraw(scope, camera) {
    if (!uuid(camera?.leaseId)) return;
    try {
      const result = await this.post(scope, 'camera', {action:'stop', expectedRevision:camera.revision, leaseId:camera.leaseId, idempotencyKey:this.newId()}, {keepalive:true});
      return supportedEnvelope(result);
    } catch { /* Local capture is already off; the host lease also has a deadline. */ return false; }
  }
  async stop(message = 'Camera off. Enable camera to start another session capture.') {
    ++this.generation;
    const lease = this.lease;
    this.lease = null;
    this.operation = null;
    this.renewing = false;
    this.abort?.abort();
    this.cancel(this.timer);
    stopHandle(this.running); this.running = null;
    stopHandle(this.prepared); this.prepared = null;
    this.emit({phase:'off', available:false, captureActive:false, currentObservationUsable:false, message});
    if (lease) await this.withdraw(lease.scope, lease.camera);
  }
}

export function installConversationCamera({anchor, api, scope, capture = null}) {
  const panel = document.createElement('section');
  panel.className = 'room-camera'; panel.setAttribute('aria-label', 'Conversation camera');
  panel.innerHTML = '<h4>Camera for this conversation</h4><p data-camera-state role="status" aria-live="polite">Camera off</p><p data-camera-source></p><p class="muted">Purpose: visible context for this conversation. Camera use is separate from the microphone. Leaving this page, hiding the app or changing the session stops capture; returning never restarts it.</p><div class="actions"><button type="button" class="secondary" data-camera-check>Check camera availability</button><button type="button" data-camera-enable disabled>Enable camera</button><button type="button" class="secondary" data-camera-stop disabled>Stop camera</button></div><p class="muted" data-camera-limits>Text and audio work independently of camera availability.</p>';
  anchor.append(panel);
  const get = name => panel.querySelector(`[data-camera-${name}]`);
  const camera = new ConversationCamera({api, scope, capture,
    visible:() => !document.hidden && location.hash === '#conversation', onState:value => {
      panel.dataset.cameraPhase = value.phase;
      get('state').textContent = value.message;
      get('source').textContent = `Source: ${value.source}. Camera ${value.captureActive ? 'capturing' : 'off'}.`;
      get('check').disabled = ['checking','requesting','capturing'].includes(value.phase);
      get('enable').disabled = !value.available || ['checking','requesting','capturing'].includes(value.phase);
      get('stop').disabled = !['checking','requesting','capturing'].includes(value.phase);
    }});
  get('check').onclick = () => void camera.check();
  get('enable').onclick = () => void camera.enable();
  get('stop').onclick = () => void camera.stop();
  for (const type of ['lifestream-auth','lifestream-assistant','lifestream-relationship','lifestream-audience','lifestream-session-context']) window.addEventListener(type, () => void camera.stop('Camera off because the conversation scope changed. Check availability to enable it again.'));
  window.addEventListener('hashchange', () => { if (location.hash !== '#conversation') void camera.stop('Camera stopped when you left the conversation.'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void camera.stop('Camera stopped while the app was hidden.'); });
  window.addEventListener('pagehide', () => void camera.stop('Camera stopped when this page closed.'));
  window.addEventListener('offline', () => void camera.stop('Camera stopped because the connection was lost.'));
  return camera;
}
