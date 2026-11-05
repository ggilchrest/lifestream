import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {serveDailyWeb} from '../src/runtime/daily-web.ts';

test('Daily serves its bounded public graph without exposing other roots or replacing Console', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daily-web-')), directory = join(root, 'public');
  await mkdir(join(directory, 'owners'), {recursive: true});
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Daily</title>');
  await writeFile(join(directory, 'owners', 'room.js'), 'export const room = true;');
  await writeFile(join(root, 'outside.js'), 'PRIVATE_TEST_SENTINEL');
  await symlink(join(root, 'outside.js'), join(directory, 'owners', 'escape.js'));
  await writeFile(join(directory, 'owners', 'large.js'), Buffer.alloc(2 * 1024 * 1024 + 1));
  const server = createServer((request, response) => {void serveDailyWeb(request, response, directory).then(handled => {
    if (!handled) {response.writeHead(418);response.end('original host');}
  });});
  try {
    server.listen(0, '127.0.0.1');await once(server, 'listening');
    const address = server.address();assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const redirect = await fetch(base + '/daily', {redirect: 'manual'});assert.equal(redirect.status, 302);assert.equal(redirect.headers.get('location'), '/daily/');
    const index = await fetch(base + '/daily/');assert.equal(index.status, 200);assert.equal(await index.text(), '<!doctype html><title>Daily</title>');assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    const owner = await fetch(base + '/daily/owners/room.js');assert.equal(owner.status, 200);assert.equal(await owner.text(), 'export const room = true;');assert.match(owner.headers.get('content-type')!, /^text\/javascript/);
    const head = await fetch(base + '/daily/owners/room.js', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('export const room = true;')));
    for (const path of ['/daily/.git/config', '/daily/owners/escape.js', '/daily/owners/large.js', '/daily/owners/%2e%2e%2foutside.js', '/daily/owners/room.js%00', '/daily/owners/nested/room.js', '/daily/state.sqlite']) {
      const result = await fetch(base + path);assert.equal(result.status, 404, path);assert.doesNotMatch(await result.text(), /PRIVATE_TEST_SENTINEL/);
    }
    const write = await fetch(base + '/daily/', {method: 'POST', body: 'ignored'});assert.equal(write.status, 405);assert.equal(write.headers.get('allow'), 'GET, HEAD');
    const console = await fetch(base + '/control/');assert.equal(console.status, 418);assert.equal(await console.text(), 'original host');
  } finally {await new Promise<void>(resolve => server.close(() => resolve()));await rm(root, {recursive: true, force: true});}
});

test('saved native Daily entries redirect only to the canonical graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daily-native-entry-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Canonical Daily</title>');
  const server = createServer((request, response) => {void serveDailyWeb(request, response, root).then(handled => {
    if (!handled) {response.writeHead(418);response.end('original host');}
  });});
  try {
    server.listen(0, '127.0.0.1');await once(server, 'listening');
    const address = server.address();assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of ['/daily/native', '/daily/native/', '/daily/native/index.html']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + path + '#conversation', {method, redirect: 'manual'});
        assert.equal(response.status, 302, `${method} ${path}`);
        assert.equal(response.headers.get('location'), '/daily/');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(await response.text(), '');
      }
    }
    const followed = await fetch(base + '/daily/native/#conversation');
    // Fetch exposes the transport URL without a fragment; navigation-fragment
    // continuity is checked separately in the actual browser qualification.
    assert.equal(followed.status, 200);assert.equal(followed.url, base + '/daily/');
    assert.equal(await followed.text(), '<!doctype html><title>Canonical Daily</title>');
    for (const path of ['/daily/native/owners/room.js', '/daily/native/%2e%2e%2findex.html', '/daily/native/index.html/', '/daily/test/fixture.mjs']) {
      const response = await fetch(base + path, {redirect: 'manual'});assert.equal(response.status, 404, path);
    }
    const write = await fetch(base + '/daily/native/', {method: 'POST', body: 'ignored', redirect: 'manual'});
    assert.equal(write.status, 405);assert.equal(write.headers.get('allow'), 'GET, HEAD');
  } finally {await new Promise<void>(resolve => server.close(() => resolve()));await rm(root, {recursive: true, force: true});}
});
