const VERSION = '1.0.0';
const WIRE_PROFILE = 'lifestream.visual-input-http';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const finite = value => Number.isFinite(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length <= 8192;
const wipe = bytes => bytes?.fill(0);
const releaseFrame = frame => { try { frame?.release?.(); } catch { /* Capture cleanup must continue. */ } };
const stoppedSources = new WeakSet();
const stopSource = source => {
  if (!source || typeof source !== 'object' || stoppedSources.has(source)) return;
  stoppedSources.add(source);
  for (const track of source.tracks ?? []) { try { track.stop(); } catch { /* Stop every track. */ } }
  try { source.stop?.(); } catch { /* Release the prepared broker too. */ }
};

function limitsFor(negotiation) {
  const b = negotiation?.bounds;
  if (!b || !['maxFrameBytes','maxLongEdgePixels','maxCaptureFramesPerSecond','minAdmissionIntervalMs','deadlineMs','freshnessMs','maxClockUncertaintyMs'].every(key => positive(b[key]))) throw Error('The service did not advertise bounded frame transport.');
  const mediaType = negotiation.mediaTypes?.includes('image/jpeg') ? 'image/jpeg' : negotiation.mediaTypes?.includes('image/png') ? 'image/png' : null;
  if (!mediaType) throw Error('No supported camera image format was negotiated.');
  return {maxFrameBytes:Math.min(1048576,b.maxFrameBytes), maxLongEdgePixels:Math.min(1280,b.maxLongEdgePixels),
    intervalMs:Math.max(1000,b.minAdmissionIntervalMs,Math.ceil(1000 / b.maxCaptureFramesPerSecond)),
    freshnessMs:Math.max(0,Math.min(6000,b.freshnessMs) - Math.min(250,b.maxClockUncertaintyMs)), encodeDeadlineMs:Math.min(3000,b.deadlineMs), requestDeadlineMs:5000, mediaType};
}

/** Encode one already bounded, ephemeral source; never acquire a media device. */
export async function encodeCameraFrame(frame, {maxFrameBytes,maxLongEdgePixels,mediaType,signal}) {
  if (signal.aborted) throw Error('Camera encoding cancelled.');
  if (!positive(frame?.width) || !positive(frame?.height) || Math.max(frame.width,frame.height) > maxLongEdgePixels) throw Error('The camera source exceeded the negotiated image dimensions.');
  const canvas = document.createElement('canvas');
  canvas.width = frame.width; canvas.height = frame.height;
  try {
    const context = canvas.getContext('2d', {alpha:false});
    if (!context) throw Error('Camera image encoding is unavailable.');
    context.drawImage(frame.image,0,0,frame.width,frame.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,mediaType,0.8));
    if (signal.aborted) throw Error('Camera encoding cancelled.');
    if (!blob || blob.type !== mediaType || blob.size > maxFrameBytes) throw Error('The encoded camera frame exceeded its negotiated limit.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (signal.aborted) { wipe(bytes); throw Error('Camera encoding cancelled.'); }
    return bytes;
  } finally {
    // Reset the scratch canvas and drop codec/blob references. Browser-owned
    // codec/network copies cannot be explicitly wiped by JavaScript.
    canvas.width = 0; canvas.height = 0;
  }
}

const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value => value.toString(16).padStart(2,'0')).join('');

/** A byte envelope (not FormData, which adds a filename to Blob parts). */
export function cameraMultipart(metadata, frame, boundary) {
  if (!uuid(frame.frameId) || !/^lifestream-[0-9a-f-]{36}$/iu.test(boundary) || !['image/jpeg','image/png'].includes(frame.mediaType)) throw Error('Invalid camera multipart envelope.');
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${frame.frameId}"\r\nContent-Type: ${frame.mediaType}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + frame.bytes.length + suffix.length);
  body.set(prefix); body.set(frame.bytes,prefix.length); body.set(suffix,prefix.length + frame.bytes.length);
  return {body,headers:{'content-type':`multipart/form-data; boundary=${boundary}`}};
}

function currentResult(value, frameId) {
  if (value?.wireProfile !== WIRE_PROFILE || value.schemaVersion !== VERSION || !uuid(value.requestId) || typeof value.queued !== 'boolean') throw Error('Unsupported camera result.');
  const result = value.result;
  if (!result || result.requestId !== value.requestId || !['complete','empty','rejected','cancelled','timedOut','failed'].includes(result.status) ||
    (result.reason !== null && (typeof result.reason !== 'string' || result.reason.length > 128)) || !Array.isArray(result.observations) || result.observations.length > 32) throw Error('Invalid camera result.');
  if (result.status !== 'complete') {
    if (result.observations.length) throw Error('Invalid camera result.');
    return false;
  }
  for (const observation of result.observations) {
    if (!text(observation?.observationId) || !observation.observationId.length || !Array.isArray(observation.frameIds) || observation.frameIds.length !== 1 || observation.frameIds[0] !== frameId ||
      !text(observation.appearance) || (observation.inference !== null && !text(observation.inference)) ||
      (observation.confidence !== null && (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1)) ||
      !Array.isArray(observation.limitations) || observation.limitations.length > 8192 || observation.limitations.some(value => !text(value))) throw Error('Invalid camera observation.');
  }
  return result.observations.length > 0;
}

/**
 * One encoder, one HTTP request and one newest pending encoded frame. The
 * trusted source owns its capture buffers and must release them on stop.
 * Nothing here persists bytes, interprets pixels or changes conversation text.
 */
export class CameraFrameTransport {
  constructor({source,api,scope,lease,negotiation,endpointClockId,localExpiresMonotonicMs,signal,
    isCurrent = () => true,onObservation = () => {},onEnded = () => {},
    now = () => performance.now(),newId = () => crypto.randomUUID(),schedule = (fn,ms) => setTimeout(fn,ms),cancel = timer => clearTimeout(timer),
    encode = encodeCameraFrame,digest = sha256}) {
    Object.assign(this,{source,api,scope,endpointClockId,signal,isCurrent,onObservation,onEnded,now,newId,schedule,cancel,encode,digest});
    this.epoch = 0; this.sequence = 0; this.lastCapture = -Infinity; this.lastSend = -Infinity; this.lastNow = now();
    this.stopped = false; this.suspended = false; this.usableUntil = 0;
    this.configure({lease,negotiation,localExpiresMonotonicMs});
    this.abort = () => this.stop();
    signal?.addEventListener('abort',this.abort,{once:true});
    if (signal?.aborted) this.stop();
    else this.timer = schedule(() => this.tick(),0);
  }
  configure({lease,negotiation,localExpiresMonotonicMs}) {
    if (!uuid(lease?.leaseId) || !uuid(lease.clockMappingId) || lease.captureActive !== true || !finite(localExpiresMonotonicMs) || localExpiresMonotonicMs <= this.now()) throw Error('No current bounded camera lease.');
    this.lease = lease; this.expires = localExpiresMonotonicMs; this.limits = limitsFor(negotiation);
  }
  observation(usable) {
    if (!usable) this.usableUntil = 0;
    this.onObservation({currentObservationUsable:usable});
  }
  current(epoch = this.epoch) { const now=this.now(); return !this.stopped && !this.suspended && epoch === this.epoch && now >= this.lastNow && now < this.expires && this.isCurrent(); }
  tick() {
    this.cancel(this.timer);
    if (this.stopped) return;
    const now = this.now();
    if (!this.isCurrent() || now < this.lastNow || now >= this.expires) return this.fail('Camera capture stopped because its session or lease expired.');
    this.lastNow = now;
    if (this.usableUntil && now >= this.usableUntil) this.observation(false);
    if (this.encoding && now >= this.encoding.deadline) return this.fail('Camera image encoding timed out.');
    if (this.inflight && now >= this.inflight.deadline) return this.fail('Camera frame delivery timed out. Enable camera again to retry.');
    if (!this.suspended) {
      if (!this.encoding && now - this.lastCapture >= this.limits.intervalMs) void this.capture();
      this.drain();
    }
    this.timer = this.schedule(() => this.tick(),Math.min(100,this.expires - now));
  }
  async capture() {
    const epoch = this.epoch, operation = {epoch,controller:new AbortController(),frame:null,deadline:this.now() + this.limits.encodeDeadlineMs};
    this.encoding = operation; this.lastCapture = this.now();
    let bytes;
    try {
      const frame = await this.source.readFrame({signal:operation.controller.signal,maxLongEdgePixels:this.limits.maxLongEdgePixels});
      if (!this.current(epoch)) { releaseFrame(frame); return; }
      operation.frame = frame;
      if (!frame || typeof frame.release !== 'function' || !finite(frame.capturedMonotonicMs) || frame.capturedMonotonicMs > this.now() || this.now() - frame.capturedMonotonicMs >= this.limits.freshnessMs ||
        !positive(frame.width) || !positive(frame.height) || Math.max(frame.width,frame.height) > this.limits.maxLongEdgePixels) throw Error('The camera source returned an invalid or stale frame.');
      const limits = this.limits;
      const capturedMonotonicMs = frame.capturedMonotonicMs;
      bytes = await this.encode(frame,{...limits,signal:operation.controller.signal});
      operation.bytes = bytes;
      releaseFrame(operation.frame); operation.frame = null;
      if (!this.current(epoch)) return;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > limits.maxFrameBytes) throw Error('The camera source exceeded its encoded frame limit.');
      const hash = await this.digest(bytes);
      if (!this.current(epoch) || this.now() >= operation.deadline || this.now() - capturedMonotonicMs >= limits.freshnessMs) return;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) throw Error('Camera frame digest failed.');
      const pending = {epoch,bytes,frameId:this.newId(),sequence:this.sequence++,capturedMonotonicMs,
        clockMappingId:this.lease.clockMappingId,mediaType:limits.mediaType,sha256:hash};
      wipe(this.pending?.bytes); this.pending = pending; bytes = null; operation.bytes = null;
      this.drain();
    } catch (error) { if (this.current(epoch)) this.fail(error.message || 'Camera frame capture failed.'); }
    finally {
      wipe(bytes); releaseFrame(operation.frame); operation.frame = null;
      if (this.encoding === operation) this.encoding = null;
    }
  }
  drain() {
    if (!this.current() || this.inflight || !this.pending || this.now() - this.lastSend < this.limits.intervalMs) return;
    const frame = this.pending; this.pending = null;
    if (frame.epoch !== this.epoch || this.now() - frame.capturedMonotonicMs >= this.limits.freshnessMs) { wipe(frame.bytes); return; }
    void this.send(frame);
  }
  async send(frame) {
    const {bytes,epoch,...metadata} = frame;
    const request = cameraMultipart({schemaVersion:VERSION,assistantId:this.scope.assistantId,leaseId:this.lease.leaseId,
      endpointClockId:this.endpointClockId,correlationId:this.newId(),frames:[metadata]},frame,`lifestream-${this.newId()}`);
    wipe(bytes);
    const operation = {epoch,body:request.body,controller:new AbortController(),deadline:Math.min(this.expires,this.now() + this.limits.requestDeadlineMs)};
    this.inflight = operation; this.lastSend = this.now();
    try {
      const value = await this.api(`/api/runtime/vision/v1/sessions/${encodeURIComponent(this.scope.sessionId)}/batches`,
        {method:'POST',body:request.body,headers:request.headers,signal:operation.controller.signal});
      if (!this.current(epoch)) return;
      if (this.now() >= operation.deadline) return this.fail('Camera frame delivery timed out. Enable camera again to retry.');
      const usable = currentResult(value,frame.frameId);
      // Result arrival never extends capture-time freshness, even if the
      // provider or network spent most of the usable interval returning it.
      this.usableUntil = Math.min(this.expires,frame.capturedMonotonicMs + this.limits.freshnessMs);
      this.observation(usable && this.now() < this.usableUntil);
    } catch (error) { if (this.current(epoch)) this.fail(error.message || 'Camera frame delivery failed.'); }
    finally {
      wipe(operation.body);
      if (this.inflight === operation) {
        this.inflight = null;
        // Pace from receipt, not only request-send time: varying network delay
        // must not squeeze two host admissions inside its minimum interval.
        this.lastSend = this.now();
      }
    }
  }
  suspend() {
    if (this.stopped) return;
    this.suspended = true; ++this.epoch;
    wipe(this.pending?.bytes); this.pending = null;
    this.encoding?.controller.abort(); wipe(this.encoding?.bytes); releaseFrame(this.encoding?.frame); if (this.encoding) this.encoding.frame = null;
    this.observation(false);
    // Keep the old HTTP request alive: disconnecting it can withdraw the host
    // lease, whose UUID is deliberately retained across renewal.
  }
  renew(value) {
    if (this.stopped) throw Error('Camera capture has stopped.');
    if (value.lease?.leaseId !== this.lease.leaseId) throw Error('Camera lease identity changed.');
    this.suspend(); this.configure(value); this.suspended = false;
  }
  fail(message) { this.stop(); this.onEnded(message); }
  stop() {
    if (this.stopped) return;
    this.stopped = true; ++this.epoch; this.cancel(this.timer);
    this.signal?.removeEventListener('abort',this.abort);
    this.encoding?.controller.abort(); wipe(this.encoding?.bytes); releaseFrame(this.encoding?.frame); if (this.encoding) this.encoding.frame = null;
    this.inflight?.controller.abort(); wipe(this.inflight?.body);
    wipe(this.pending?.bytes); this.pending = null; this.observation(false);
    stopSource(this.source);
  }
}

/**
 * Explicit opt-in only. A host binding alone is not a browser device ID.
 * broker.prepare authorizes/binds without capture; prepared.start starts only
 * with the supplied host lease. Its source.readFrame returns a fresh owned
 * {image,width,height,capturedMonotonicMs,release} with dimensions already within
 * the requested maximum and capture time in the endpoint performance.now clock.
 * source.stop must end capture and release all broker-owned media immediately.
 */
export function createCameraFrameAdapter(broker, options = {}) {
  if (!broker || typeof broker.prepare !== 'function' || typeof broker.sourceLabel !== 'string') throw Error('A trusted camera source broker is required.');
  return {sourceLabel:broker.sourceLabel,async prepare(context) {
    const prepared = await broker.prepare(context);
    if (!prepared || typeof prepared.start !== 'function' || typeof prepared.release !== 'function') { try { prepared?.release?.(); } catch { /* Invalid source cannot capture. */ } throw Error('Camera broker preparation failed.'); }
    let running, source, released = false, started = false;
    const stop = () => {
      running?.stop();
      stopSource(source);
      source = null;
    };
    return {sourceLabel:prepared.sourceLabel ?? broker.sourceLabel,
      release() { if (released) return; released = true; stop(); prepared.release(); },
      async start(value) {
        if (released || started || value.signal?.aborted) throw Error('Camera broker preparation was withdrawn.');
        started = true;
        source = await prepared.start(value);
        if (released || value.signal?.aborted) { stop(); throw Error('Camera capture was withdrawn.'); }
        if (!source || typeof source.readFrame !== 'function' || typeof source.stop !== 'function') { stop(); throw Error('Camera source cannot supply bounded frames.'); }
        try { running = new CameraFrameTransport({...options,...value,source}); }
        catch (error) { stop(); throw error; }
        return {tracks:source.tracks ?? [],stop,suspend:() => running.suspend(),renew:next => running.renew(next)};
      }};
  }};
}
