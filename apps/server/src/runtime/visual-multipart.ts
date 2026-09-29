import type { IncomingMessage } from 'node:http';

type VisualMediaType = 'image/jpeg' | 'image/png';
type VisualPart = { mediaType: VisualMediaType; bytes: Uint8Array };

const MAX_METADATA_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 2_097_152;
const MAX_FRAMES = 3;
export const MAX_VISUAL_METADATA_BYTES = MAX_METADATA_BYTES;
export const VISUAL_FRAMING_BYTES = 32_768;
const MAX_REQUEST_BYTES = MAX_METADATA_BYTES + MAX_FRAMES * MAX_FRAME_BYTES + 32_768;
const MAX_PART_HEADERS_BYTES = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOUNDARY = /^[A-Za-z0-9'()+_,.\/:=?-]{1,70}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HEADER_END = Buffer.from('\r\n\r\n');

export class VisualMultipartError extends Error {
  readonly status: 400 | 408 | 413 | 415;
  readonly code: 'visual_multipart_invalid' | 'visual_multipart_too_large' | 'visual_multipart_unsupported_media' | 'visual_multipart_timeout' | 'visual_multipart_cancelled';
  constructor(status: 400 | 408 | 413 | 415, code: VisualMultipartError['code']) {
    super(code);
    this.name = 'VisualMultipartError';
    this.status = status;
    this.code = code;
  }
}

const invalid = (): never => { throw new VisualMultipartError(400, 'visual_multipart_invalid'); };
const tooLarge = (): never => { throw new VisualMultipartError(413, 'visual_multipart_too_large'); };
const unsupported = (): never => { throw new VisualMultipartError(415, 'visual_multipart_unsupported_media'); };

function boundaryFor(request: IncomingMessage): string {
  const value = request.headers['content-type'];
  if (typeof value !== 'string') return unsupported();
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^\s;]+))$/i.exec(value);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || !BOUNDARY.test(boundary)) return unsupported();
  if (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') return unsupported();
  return boundary;
}

function declaredLength(request: IncomingMessage, maxRequestBytes: number): number | null {
  const value = request.headers['content-length'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return invalid();
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return tooLarge();
  if (length > maxRequestBytes) return tooLarge();
  return length;
}

export type VisualMultipartOptions = Readonly<{maxFrameBytes?:number; maxFrames?:number; maxRequestBytes?:number; deadlineMs?:number; signal?:AbortSignal}>;
type Limits = {maxFrameBytes:number; maxFrames:number; maxRequestBytes:number; deadlineMs:number};
function effectiveLimits(options: VisualMultipartOptions): Limits {
  const maxima = {maxFrameBytes:MAX_FRAME_BYTES,maxFrames:MAX_FRAMES,maxRequestBytes:MAX_REQUEST_BYTES,deadlineMs:5_000};
  return Object.fromEntries(Object.entries(maxima).map(([key,max]) => {
    const value = options[key as keyof Limits] ?? max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid visual transport limit');
    return [key,value];
  })) as Limits;
}

async function readBounded(request: IncomingMessage, limits: Limits, signal?: AbortSignal): Promise<Buffer> {
  const length = declaredLength(request,limits.maxRequestBytes);
  if (signal?.aborted) throw new VisualMultipartError(400,'visual_multipart_cancelled');
  // One owned envelope backs every part. No accumulation/concat/frame copies.
  const body = Buffer.alloc(length ?? limits.maxRequestBytes);
  return await new Promise<Buffer>((resolve,reject) => {
    let size = 0, finished = false;
    const cleanup = () => {
      clearTimeout(deadline);
      request.off('data',data); request.off('end',end); request.off('error',failed); request.off('aborted',aborted);
      signal?.removeEventListener('abort',cancelled);
    };
    const fail = (error: VisualMultipartError) => {
      if (finished) return;
      finished=true; cleanup(); body.fill(0);
      // Stop delivery; the HTTP owner closes an unread connection after its
      // error response rather than draining an attacker-controlled stream.
      request.pause();
      reject(error);
    };
    const data = (chunk: Buffer | Uint8Array) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);
      if (bytes.length > body.length-size) return fail(new VisualMultipartError(413,'visual_multipart_too_large'));
      bytes.copy(body,size); size+=bytes.length;
    };
    const end = () => {
      if (finished) return;
      if (length !== null && length !== size) return fail(new VisualMultipartError(400,'visual_multipart_invalid'));
      finished=true; cleanup(); resolve(body.subarray(0,size));
    };
    const failed = () => fail(new VisualMultipartError(400,'visual_multipart_invalid'));
    const aborted = () => fail(new VisualMultipartError(400,'visual_multipart_cancelled'));
    const cancelled = () => fail(new VisualMultipartError(400,'visual_multipart_cancelled'));
    const deadline = setTimeout(()=>fail(new VisualMultipartError(408,'visual_multipart_timeout')),limits.deadlineMs);
    request.on('data',data); request.once('end',end); request.once('error',failed); request.once('aborted',aborted);
    signal?.addEventListener('abort',cancelled,{once:true});
  });
}

function headersFor(body: Buffer, start: number): { name: string; mediaType: string | null; bodyStart: number } {
  const end = body.indexOf(HEADER_END, start);
  if (end < 0 || end - start > MAX_PART_HEADERS_BYTES || end === start) return invalid();
  const raw = body.toString('latin1', start, end);
  const headers = new Map<string, string>();
  for (const line of raw.split('\r\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ ]*([\x20-\x7e]+)$/.exec(line);
    if (!match) return invalid();
    const key = match[1]!.toLowerCase();
    if (headers.has(key) || (key !== 'content-disposition' && key !== 'content-type')) return invalid();
    headers.set(key, match[2]!.trim());
  }
  const disposition = headers.get('content-disposition');
  const match = disposition && /^form-data;[ ]*name="([^"]+)"$/i.exec(disposition);
  if (!match) return invalid();
  return { name: match[1]!, mediaType: headers.get('content-type') ?? null, bodyStart: end + HEADER_END.length };
}

function nextDelimiter(body: Buffer, start: number, marker: Buffer): { end: number; after: number; final: boolean } {
  let at = start;
  while ((at = body.indexOf(marker, at)) !== -1) {
    const after = at + marker.length;
    if (body[after] === 45 && body[after + 1] === 45) return { end: at, after: after + 2, final: true };
    if (body[after] === 13 && body[after + 1] === 10) return { end: at, after: after + 2, final: false };
    at++;
  }
  return invalid();
}

function declaredFrameIds(metadata: unknown, maxFrames: number): Set<string> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return invalid();
  const frames = (metadata as Record<string, unknown>).frames;
  if (!Array.isArray(frames) || frames.length === 0) return invalid();
  if (frames.length > maxFrames) return tooLarge();
  const ids = new Set<string>();
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return invalid();
    const id = (frame as Record<string, unknown>).frameId;
    if (typeof id !== 'string' || !UUID.test(id) || ids.has(id)) return invalid();
    ids.add(id);
  }
  return ids;
}

function parse(body: Buffer, boundary: string, limits: Limits): { metadata: unknown; parts: ReadonlyMap<string, VisualPart> } {
  const opening = Buffer.from(`--${boundary}\r\n`);
  if (body.length < opening.length || !body.subarray(0, opening.length).equals(opening)) return invalid();
  const marker = Buffer.from(`\r\n--${boundary}`);
  const parts = new Map<string, VisualPart>();
  let cursor = opening.length;
  let metadata: unknown;
  let hasMetadata = false;
  let finished = false;
  try {
    while (!finished) {
      const header = headersFor(body, cursor);
      const delimiter = nextDelimiter(body, header.bodyStart, marker);
      const size = delimiter.end - header.bodyStart;
      if (header.name === 'metadata') {
        if (hasMetadata) return invalid();
        if (size > MAX_METADATA_BYTES) return tooLarge();
        if (header.mediaType !== null && !/^application\/json(?:;[ ]*charset=utf-8)?$/i.test(header.mediaType)) return unsupported();
        try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(header.bodyStart, delimiter.end))); }
        catch { return invalid(); }
        hasMetadata = true;
      } else {
        if (!UUID.test(header.name) || parts.has(header.name)) return invalid();
        if (parts.size >= limits.maxFrames || size > limits.maxFrameBytes) return tooLarge();
        const mediaType = header.mediaType?.toLowerCase();
        if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') return unsupported();
        const bytes = body.subarray(header.bodyStart, delimiter.end);
        if (mediaType === 'image/png' && (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))) return invalid();
        if (mediaType === 'image/jpeg' && (bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)) return invalid();
        parts.set(header.name, { mediaType, bytes });
      }
      cursor = delimiter.after;
      finished = delimiter.final;
    }
    if (cursor < body.length && body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    if (cursor !== body.length || !hasMetadata || parts.size === 0) return invalid();
    const declared = declaredFrameIds(metadata,limits.maxFrames);
    if (declared.size !== parts.size || [...declared].some(id => !parts.has(id))) return invalid();
    return { metadata, parts };
  } catch (error) {
    for (const part of parts.values()) part.bytes.fill(0);
    throw error;
  }
}

/** Only a bounded, unambiguous body reaches visual admission. No media is decoded or persisted here. */
export async function readVisualMultipart(request: IncomingMessage, options: VisualMultipartOptions = {}): Promise<{ metadata: unknown; parts: ReadonlyMap<string, VisualPart>; dispose: () => void }> {
  const boundary = boundaryFor(request), limits = effectiveLimits(options);
  const body = await readBounded(request,limits,options.signal);
  try {
    const parsed = parse(body, boundary, limits);
    return {...parsed,dispose:()=>body.fill(0)};
  } catch(error) {
    body.fill(0);
    throw error;
  }
}
