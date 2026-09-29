import type { IncomingMessage } from 'node:http';

type VisualMediaType = 'image/jpeg' | 'image/png';
type VisualPart = { mediaType: VisualMediaType; bytes: Uint8Array };

const MAX_METADATA_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 2_097_152;
const MAX_FRAMES = 3;
const MAX_REQUEST_BYTES = MAX_METADATA_BYTES + MAX_FRAMES * MAX_FRAME_BYTES + 32_768;
const MAX_PART_HEADERS_BYTES = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOUNDARY = /^[A-Za-z0-9'()+_,.\/:=?-]{1,70}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HEADER_END = Buffer.from('\r\n\r\n');

export class VisualMultipartError extends Error {
  readonly status: 400 | 413 | 415;
  readonly code: 'visual_multipart_invalid' | 'visual_multipart_too_large' | 'visual_multipart_unsupported_media';
  constructor(status: 400 | 413 | 415, code: 'visual_multipart_invalid' | 'visual_multipart_too_large' | 'visual_multipart_unsupported_media') {
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

function declaredLength(request: IncomingMessage): number | null {
  const value = request.headers['content-length'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return invalid();
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return tooLarge();
  if (length > MAX_REQUEST_BYTES) return tooLarge();
  return length;
}

async function readBounded(request: IncomingMessage): Promise<Buffer> {
  const length = declaredLength(request);
  // One owned envelope backs every part. Chunk accumulation plus concat plus
  // frame copies can multiply a legal 6 MiB batch before admission.
  const body = Buffer.alloc(length ?? MAX_REQUEST_BYTES);
  let size = 0;
  let complete = false;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (bytes.length > MAX_REQUEST_BYTES - size || bytes.length > body.length - size) {
        request.resume();
        return tooLarge();
      }
      bytes.copy(body,size);
      size += bytes.length;
    }
    if (length !== null && length !== size) return invalid();
    complete = true;
    return body.subarray(0,size);
  } catch (error) {
    if (error instanceof VisualMultipartError) throw error;
    return invalid();
  } finally {
    if (!complete) body.fill(0);
  }
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

function declaredFrameIds(metadata: unknown): Set<string> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return invalid();
  const frames = (metadata as Record<string, unknown>).frames;
  if (!Array.isArray(frames) || frames.length === 0) return invalid();
  if (frames.length > MAX_FRAMES) return tooLarge();
  const ids = new Set<string>();
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return invalid();
    const id = (frame as Record<string, unknown>).frameId;
    if (typeof id !== 'string' || !UUID.test(id) || ids.has(id)) return invalid();
    ids.add(id);
  }
  return ids;
}

function parse(body: Buffer, boundary: string): { metadata: unknown; parts: ReadonlyMap<string, VisualPart> } {
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
        if (parts.size >= MAX_FRAMES || size > MAX_FRAME_BYTES) return tooLarge();
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
    const declared = declaredFrameIds(metadata);
    if (declared.size !== parts.size || [...declared].some(id => !parts.has(id))) return invalid();
    return { metadata, parts };
  } catch (error) {
    for (const part of parts.values()) part.bytes.fill(0);
    throw error;
  }
}

/** Only a bounded, unambiguous body reaches visual admission. No media is decoded or persisted here. */
export async function readVisualMultipart(request: IncomingMessage): Promise<{ metadata: unknown; parts: ReadonlyMap<string, VisualPart>; dispose: () => void }> {
  const boundary = boundaryFor(request);
  const body = await readBounded(request);
  try {
    const parsed = parse(body, boundary);
    return {...parsed,dispose:()=>body.fill(0)};
  } catch(error) {
    body.fill(0);
    throw error;
  }
}
