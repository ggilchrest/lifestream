import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, type BigIntStats} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import type {GameVisionCapability} from '@lifestream/providers-sglang';

export type GameVisionFilePin = Readonly<{path: string; sha256: string; bytes: number}>;
export type GameVisionServiceDescriptor = Readonly<{
  process: Readonly<{pid: number; startTicks: string}>;
  /** Trusted local user-service selection. Receipt PID remains provenance. */
  serviceUnit?: string;
  projector: GameVisionFilePin;
  serviceDrop: GameVisionFilePin;
  activationReceipt: GameVisionFilePin;
  qualificationReceipt: GameVisionFilePin;
}>;
export type GameVisionServiceOptions = Readonly<{
  endpoint: string; model: string; modelRevision: string;
  descriptor: GameVisionServiceDescriptor;
  selectionCurrent: () => boolean;
  /** Finite metadata-only idle polling; never generation or a model prompt. */
  idleTimeoutMs?: number; pollIntervalMs?: number;
  slotAttemptTimeoutMs?: number;
}>;
export type GameVisionService = Readonly<{
  capability: () => GameVisionCapability | null;
  identityCurrent: () => boolean;
  available: () => boolean;
  quiescent: () => boolean;
  probeIdle: (signal?: AbortSignal) => Promise<boolean>;
  /** Call INSIDE the original foreground scheduler step. Its reservation must
   * remain held until this promise completes its independent-signal drain. */
  runWhenIdle: <T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T | null>;
}>;

const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const stamp = (s: BigIntStats) => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
type Captured = {pin: GameVisionFilePin; identity: string; content?: Buffer};
const pinValid = (p: GameVisionFilePin, max: number) => !!p && isAbsolute(p.path) && resolve(p.path) === p.path && /^[a-f0-9]{64}$/u.test(p.sha256) && Number.isSafeInteger(p.bytes) && p.bytes >= 1 && p.bytes <= max;

async function capture(pin: GameVisionFilePin, maximum: number, retain = false): Promise<Captured> {
  if (!pinValid(pin, maximum)) throw Error('Invalid vision artifact pin');
  const fd = await open(pin.path, flags);
  try {
    const before = await fd.stat({bigint: true}), named = lstatSync(pin.path, {bigint: true});
    const identity = stamp(before as any);
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(pin.bytes) || identity !== stamp(named as any) || realpathSync(pin.path) !== pin.path) throw Error('Vision artifact custody changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(pin.bytes + 1, 1024 * 1024)), chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const result = await fd.read(buffer, 0, Math.min(buffer.length, pin.bytes - total + 1), null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > pin.bytes) throw Error('Vision artifact grew');
      hash.update(buffer.subarray(0, result.bytesRead));
      if (retain) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    if (total !== pin.bytes || hash.digest('hex') !== pin.sha256 || stamp(await fd.stat({bigint: true}) as any) !== identity || stamp(lstatSync(pin.path, {bigint: true}) as any) !== identity || realpathSync(pin.path) !== pin.path) throw Error('Vision artifact digest changed');
    return retain ? {pin: Object.freeze({...pin}), identity, content: Buffer.concat(chunks)} : {pin: Object.freeze({...pin}), identity};
  } finally {await fd.close();}
}
function stable(file: Captured): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file.pin.path, flags);
    const before = fstatSync(fd, {bigint: true}), named = lstatSync(file.pin.path, {bigint: true});
    return before.isFile() && stamp(before as any) === file.identity && stamp(named as any) === file.identity && realpathSync(file.pin.path) === file.pin.path && stamp(fstatSync(fd, {bigint: true}) as any) === file.identity;
  } catch {return false;} finally {if (fd !== undefined) closeSync(fd);}
}
function procRead(path: string): Buffer {
  const fd = openSync(path, flags);
  try {const buffer = Buffer.alloc(65537); let size = 0; for (;;) {const n = readSync(fd, buffer, size, buffer.length - size, null); if (!n) break; size += n; if (size > 65536) throw Error('Vision process metadata bound');} return buffer.subarray(0, size);} finally {closeSync(fd);}
}
const ticks = (stat: string) => stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];
function processArgv(process: GameVisionServiceDescriptor['process']): string[] {
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || !/^[0-9]+$/u.test(process.startTicks)) throw Error('Invalid vision process identity');
  const prefix = `/proc/${process.pid}`;
  if (ticks(procRead(prefix + '/stat').toString()) !== process.startTicks) throw Error('Vision process changed');
  const argv = procRead(prefix + '/cmdline').toString('utf8').split('\0').filter(Boolean);
  if (ticks(procRead(prefix + '/stat').toString()) !== process.startTicks) throw Error('Vision process changed');
  return argv;
}
function single(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  return at >= 0 && argv.lastIndexOf(flag) === at && argv[at + 1] !== undefined && !argv[at + 1]!.startsWith('--') && !argv.some(v => v.startsWith(flag + '=')) ? argv[at + 1]! : null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const qualificationStatus = 'QUALIFIED_LIMITED_RETAINED_IMAGE_GROUNDING_OCR_AND_CALLER_CANCELLATION_WITH_SERVER_DRAIN_LIMITATION';

/** Trusted local process/artifact qualification. Preparation hashes the exact
 * projector once; every capability use opens fresh descriptors and checks the
 * full stable identity. No auth decision, inference result or idle TTL is cached. */
export async function prepareGameVisionService(options: GameVisionServiceOptions): Promise<GameVisionService> {
  const {endpoint, model, modelRevision, selectionCurrent} = options;
  const descriptor = structuredClone(options.descriptor), url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !model || !modelRevision || typeof selectionCurrent !== 'function') throw Error('Invalid game vision service configuration');
  // These are finite safety watchdogs. Observed successful 5s qualification
  // remains performance evidence, not a p60 estimate or a correctness cutoff.
  const idleTimeout = options.idleTimeoutMs ?? 60000, interval = options.pollIntervalMs ?? 50, attemptTimeout = options.slotAttemptTimeoutMs ?? 2000;
  if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 10 || idleTimeout > 120000 || !Number.isSafeInteger(interval) || interval < 1 || interval > 250 || !Number.isSafeInteger(attemptTimeout) || attemptTimeout < 1 || attemptTimeout > 30000) throw Error('Invalid vision idle bound');
  const projector = await capture(descriptor.projector, 2_147_483_648), drop = await capture(descriptor.serviceDrop, 65536);
  const activation = await capture(descriptor.activationReceipt, 1_048_576, true), qualification = await capture(descriptor.qualificationReceipt, 1_048_576, true);
  const activated = JSON.parse(activation.content!.toString('utf8')), qualified = JSON.parse(qualification.content!.toString('utf8'));
  delete activation.content; delete qualification.content;
  let liveProcess = descriptor.process;
  if (descriptor.serviceUnit !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}\.service$/u.test(descriptor.serviceUnit)) throw Error('Invalid vision service unit');
    const pidText = childProcess.execFileSync('/usr/bin/systemctl', ['--user','show',descriptor.serviceUnit,'--property=MainPID','--value'], {encoding:'utf8',timeout:2000,maxBuffer:4096}).trim();
    if (!/^[1-9][0-9]*$/u.test(pidText) || !Number.isSafeInteger(Number(pidText))) throw Error('Vision service is not running');
    const pid = Number(pidText), startTicks = ticks(procRead(`/proc/${pid}/stat`).toString());
    if (typeof startTicks !== 'string' || !/^[0-9]+$/u.test(startTicks)) throw Error('Vision process identity unavailable');
    liveProcess = {pid,startTicks};
  }
  const argv = processArgv(liveProcess), host = url.hostname.replace(/^\[|\]$/gu, '');
  const expectedPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (single(argv, '--model') !== model || single(argv, '--mmproj') !== descriptor.projector.path || single(argv, '--parallel') !== '1' || single(argv, '--ctx-size') !== '8192' || single(argv, '--host') !== host || single(argv, '--port') !== expectedPort ||
      activated.status !== 'SERVICE_HEALTHY_PROJECTOR_CONFIGURED_IMAGE_QUALIFICATION_PENDING' || !Number.isSafeInteger(activated.backend?.pid) || activated.backend.pid <= 0 || !/^[0-9]+$/u.test(String(activated.backend?.startTicks)) || !same(activated.backend.argv, argv) || (!descriptor.serviceUnit && (activated.backend.pid !== liveProcess.pid || String(activated.backend.startTicks) !== liveProcess.startTicks)) ||
      activated.projector?.path !== descriptor.projector.path || activated.projector?.sha256 !== descriptor.projector.sha256 || activated.projector?.bytes !== descriptor.projector.bytes || activated.dropin?.path !== descriptor.serviceDrop.path || activated.dropin?.sha256 !== descriptor.serviceDrop.sha256 || activated.dropin?.bytes !== descriptor.serviceDrop.bytes ||
      qualified.status !== qualificationStatus || qualified.reservationWindow?.servicePID !== activated.backend.pid || String(qualified.reservationWindow?.startTicks) !== String(activated.backend.startTicks) || qualified.reservationWindow?.serviceStillExact !== true || qualified.reservationWindow?.closed !== true || qualified.latencyQualification?.passedBoundMs !== 5000) throw Error('Vision qualification does not match selected service');
  const files = [projector, drop, activation, qualification], argvPin = JSON.stringify(argv);
  const identityCurrent = () => {
    try {return files.every(stable) && JSON.stringify(processArgv(liveProcess)) === argvPin;} catch {return false;}
  };
  const current = () => {try {return selectionCurrent() === true && identityCurrent();} catch {return false;}};
  const capabilityValue = Object.freeze({vision: true as const, model, modelRevision, loadedProjectorSha256: descriptor.projector.sha256});
  let active = false, probing = false, unavailable = true;
  const slotsUrl = endpoint.replace(/\/$/u, '') + '/slots';
  const oneIdle = async (deadline: number, signal?: AbortSignal): Promise<boolean> => {
    const controller = new AbortController(), abort = () => controller.abort();
    const remaining = Math.min(attemptTimeout, deadline - performance.now()); if (remaining <= 0 || signal?.aborted) return false;
    const attemptDeadline = performance.now() + remaining;
    const timer = setTimeout(abort, remaining); signal?.addEventListener('abort', abort, {once: true});
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const wait = <T>(promise: Promise<T>): Promise<T | null> => new Promise(resolve => {
      let done = false; const stopped = () => {if (!done) {done = true; resolve(null);}};
      controller.signal.addEventListener('abort', stopped, {once: true}); if (controller.signal.aborted) stopped();
      promise.then(v => {controller.signal.removeEventListener('abort', stopped); if (!done) {done = true; resolve(v);}}, () => {controller.signal.removeEventListener('abort', stopped); stopped();});
    });
    try {
      const response = await wait(fetch(slotsUrl, {method: 'GET', redirect: 'error', signal: controller.signal}));
      if (!response?.ok || !response.body || controller.signal.aborted || performance.now() >= attemptDeadline) return false;
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      for (;;) {const part = await wait(reader.read()); if (!part || controller.signal.aborted || performance.now() >= attemptDeadline) return false; if (part.done) break; total += part.value.byteLength; if (total > 65536) return false; chunks.push(part.value);}
      const data: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
      // Retain only this boolean. Never retain slot prompt/task bodies.
      return Array.isArray(data) && data.length === 1 && !!data[0] && typeof data[0] === 'object' && data[0].is_processing === false && performance.now() < deadline;
    } catch {return false;} finally {controller.abort();clearTimeout(timer);signal?.removeEventListener('abort', abort);void reader?.cancel().catch(() => {});}
  };
  const idle = async (signal: AbortSignal | undefined, requireSelection: boolean): Promise<boolean> => {
    const deadline = performance.now() + idleTimeout;
    do {
      if (signal?.aborted || !(requireSelection ? current() : identityCurrent())) return false;
      if (await oneIdle(deadline, signal)) return (requireSelection ? current() : identityCurrent());
      const delay = Math.min(interval, deadline - performance.now());
      if (delay <= 0 || signal?.aborted) break;
      await new Promise<void>(resolve => {const timer = setTimeout(done, delay); const stopped = () => done(); function done() {clearTimeout(timer);signal?.removeEventListener('abort', stopped);resolve();} signal?.addEventListener('abort', stopped, {once: true});});
    } while (performance.now() < deadline);
    return false;
  };
  const service: GameVisionService = Object.freeze({
    capability: () => current() ? capabilityValue : null,
    identityCurrent: current,
    available: () => !unavailable && current(),
    quiescent: () => !active && !probing && !unavailable && current(),
    async probeIdle(signal) {
      if (active || probing) return false; probing = true;
      try {unavailable = !await idle(signal, true);return !unavailable;} finally {probing = false;}
    },
    async runWhenIdle<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T | null> {
      if (active || probing || signal.aborted || !current()) return null;
      active = true; let entered = false, result: T | null = null;
      try {
        unavailable = !await idle(signal, true);
        if (unavailable || signal.aborted || !current()) return null;
        entered = true; result = await work(signal);
      } finally {
        if (entered) {
          // Caller cancellation does not prove server cancellation. Keep the
          // original foreground reservation until real idle or a closed latch.
          // Busy/draining is not service identity loss. Keep source currentness
          // stable while the original scheduler still holds this serial work.
          unavailable = !await idle(undefined, false);
        }
        active = false;
      }
      return !unavailable && !signal.aborted && current() ? result : null;
    }
  });
  await service.probeIdle();
  return service;
}
