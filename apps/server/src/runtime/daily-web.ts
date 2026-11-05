import type {IncomingMessage, ServerResponse} from 'node:http';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../daily-web/', import.meta.url));
const rootAssets = new Set(['index.html', 'app.js', 'styles.css', 'icons.js']);
const maximumAssetBytes = 2 * 1024 * 1024;

/** Daily has its own application graph. The existing Console graph and vendor
 * routes remain owned by the original host. Only public frontend source lives
 * in this directory; runtime state and appearance packages are never served. */
export async function serveDailyWeb(request: IncomingMessage, response: ServerResponse, directory = sourceRoot): Promise<boolean> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path !== '/daily' && !path.startsWith('/daily/')) return false;
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('x-content-type-options', 'nosniff');
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, {allow: 'GET, HEAD'});response.end();return true;
  }
  if (path === '/daily' || path === '/daily/native' || path === '/daily/native/' || path === '/daily/native/index.html') {
    // Keep saved native-entry URLs on this graph. A fragment-free Location
    // preserves the browser's existing conversation fragment on redirect.
    response.writeHead(302, {location: '/daily/'});response.end();return true;
  }
  const name = path.slice('/daily/'.length) || 'index.html';
  if (!rootAssets.has(name) && !/^owners\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:js|mjs|css)$/.test(name)) {
    response.writeHead(404);response.end();return true;
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(directory), filename = await realpath(resolve(root, name));
    if (!filename.startsWith(root + sep)) throw new Error('Outside public Daily source');
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximumAssetBytes) throw new Error('Unavailable public Daily asset');
    const body = await file.readFile();
    if (body.length > maximumAssetBytes) throw new Error('Public Daily asset exceeds bound');
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    response.writeHead(200, {'content-type': type, 'content-length': body.length});
    response.end(method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404);response.end();
  } finally {await file?.close();}
  return true;
}
