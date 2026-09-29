import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readVisualMultipart, VisualMultipartError } from '../src/runtime/visual-multipart.ts';

const boundary = 'visual-boundary-1';
const frameA = '11111111-1111-4111-8111-111111111111';
const frameB = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8ANywAAAABJRU5ErkJggg==', 'base64');

type Part = { name: string; bytes: Buffer; mediaType?: string; headers?: string[] };
function multipart(parts: Part[], closing = `--${boundary}--\r\n`): Buffer {
  return Buffer.concat([
    ...parts.flatMap(part => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n${part.mediaType ? `Content-Type: ${part.mediaType}\r\n` : ''}${(part.headers ?? []).map(header => `${header}\r\n`).join('')}\r\n`),
      part.bytes,
      Buffer.from('\r\n')
    ]),
    Buffer.from(closing)
  ]);
}
const metadata = (value: unknown = { frames: [{ frameId: frameA }] }): Part => ({ name: 'metadata', bytes: Buffer.from(JSON.stringify(value)), mediaType: 'application/json' });
const frame = (name = frameA, bytes = png, mediaType = 'image/png'): Part => ({ name, bytes, mediaType });
function request(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([body.subarray(0, Math.floor(body.length / 2)), body.subarray(Math.floor(body.length / 2))]);
  return Object.assign(stream, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers } }) as unknown as IncomingMessage;
}
async function failure(body: Buffer, status: number, code: string, headers?: Record<string, string>): Promise<void> {
  await assert.rejects(readVisualMultipart(request(body, headers)), error =>
    error instanceof VisualMultipartError && error.status === status && error.code === code);
}

test('accepts bounded binary PNG/JPEG parts keyed by UUID and JSON metadata', async () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
  const body = multipart([metadata({ frames: [{ frameId: frameA }, { frameId: frameB }] }), frame(frameA), frame(frameB, jpeg, 'image/jpeg')]);
  const result = await readVisualMultipart(request(body, { 'content-length': String(body.length) }));
  assert.deepEqual(result.metadata, { frames: [{ frameId: frameA }, { frameId: frameB }] });
  assert.deepEqual([...result.parts.keys()], [frameA, frameB]);
  assert.equal(result.parts.get(frameA)?.mediaType, 'image/png');
  assert.deepEqual(result.parts.get(frameA)?.bytes, png);
  assert.deepEqual(result.parts.get(frameB)?.bytes, jpeg);
  assert.equal(result.parts.get(frameA)?.bytes.buffer, result.parts.get(frameB)?.bytes.buffer, 'frame views share one owned bounded envelope');
  const first=result.parts.get(frameA)!.bytes;
  result.dispose();
  assert.ok(first.every(byte=>byte===0), 'disposal wipes the owned raw media');
  const textMetadata = { name: 'metadata', bytes: metadata().bytes };
  const fromTextPart = await readVisualMultipart(request(multipart([textMetadata, frame()]), { 'content-type': `multipart/form-data; boundary="${boundary}"` }));
  assert.equal(fromTextPart.parts.size, 1, 'plain browser text metadata need not declare a media type');
  fromTextPart.dispose();
});

test('does not confuse a near-boundary sequence within binary media with a delimiter', async () => {
  const withMarker = Buffer.concat([png, Buffer.from(`\r\n--${boundary}X\r\nmore bytes`)]);
  const result = await readVisualMultipart(request(multipart([metadata(), frame(frameA, withMarker)])));
  assert.deepEqual(result.parts.get(frameA)?.bytes, withMarker);
  result.dispose();
});

test('rejects missing, repeated and undeclared parts', async () => {
  await failure(multipart([frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), metadata(), frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), frame(), frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), frame('extra')]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata({ frames: [{ frameId: frameB }] }), frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata({ frames: [{ frameId: frameA }, { frameId: frameB }] }), frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), frame(), frame(frameB)]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata({ frames: [{ frameId: frameA }, { frameId: frameA }] }), frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), frame(), frame(frameB), frame('33333333-3333-4333-8333-333333333333'), frame('44444444-4444-4444-8444-444444444444')]), 413, 'visual_multipart_too_large');
});

test('rejects oversized metadata, frame and complete request before admission', async () => {
  await failure(multipart([metadata('x'.repeat(1_048_575)), frame()]), 413, 'visual_multipart_too_large');
  await failure(multipart([metadata(), frame(frameA, Buffer.concat([png, Buffer.alloc(2_097_152)]))]), 413, 'visual_multipart_too_large');
  const body = multipart([metadata(), frame()]);
  await failure(body, 413, 'visual_multipart_too_large', { 'content-length': String(8_000_000) });
  await failure(body, 400, 'visual_multipart_invalid', { 'content-length': String(body.length + 1) });
  await failure(Buffer.concat([body, Buffer.alloc(8_000_000)]), 413, 'visual_multipart_too_large');
});

test('rejects malformed framing, invalid UTF-8 or JSON, and trailing bytes', async () => {
  const body = multipart([metadata(), frame()]);
  await failure(Buffer.concat([Buffer.from('preamble'), body]), 400, 'visual_multipart_invalid');
  await failure(Buffer.concat([body, Buffer.from('epilogue')]), 400, 'visual_multipart_invalid');
  await failure(body.subarray(0, body.length - 5), 400, 'visual_multipart_invalid');
  await failure(multipart([{ name: 'metadata', bytes: Buffer.from([255]), mediaType: 'application/json' }, frame()]), 400, 'visual_multipart_invalid');
  await failure(multipart([{ name: 'metadata', bytes: Buffer.from('{bad'), mediaType: 'application/json' }, frame()]), 400, 'visual_multipart_invalid');
});

test('rejects unsupported media and ambiguous or unsafe part headers', async () => {
  await failure(multipart([metadata(), frame(frameA, png, 'image/gif')]), 415, 'visual_multipart_unsupported_media');
  await failure(multipart([metadata(), frame(frameA, Buffer.from('not a png'))]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), { ...frame(), headers: ['Content-Transfer-Encoding: base64'] }]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), { ...frame(), headers: ['Content-Disposition: form-data; name="other"'] }]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), { ...frame(), headers: ['Content-Length: 1'] }]), 400, 'visual_multipart_invalid');
  await failure(multipart([metadata(), frame()]), 415, 'visual_multipart_unsupported_media', { 'content-type': `multipart/form-data; boundary=${boundary}; charset=utf-8` });
  const filename = multipart([metadata(), frame()]).toString('latin1').replace(`name="${frameA}"`, `name="${frameA}"; filename="image.png"`);
  await failure(Buffer.from(filename, 'latin1'), 400, 'visual_multipart_invalid');
});
