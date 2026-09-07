import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
test('presence view exposes semantic signals with accessible structure', () => {
  for (const id of ['assistant-name','presence-title','presence-summary','speech-state','activity-state','attention-state','engagement-state','urgency-state','expiry-state','renderer-status']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<main class="shell">/); assert.match(html, /aria-live="polite"/); assert.match(html, /<dl class="signals">/);
  assert.match(css, /@media\(max-width:560px\)/); assert.match(css, /prefers-reduced-motion/);
});
test('presence rendering writes text only and keeps visual details out of semantic state', () => {
  assert.doesNotMatch(js, /innerHTML/); assert.match(js, /textContent/); assert.match(js, /speechState/); assert.match(js, /activity/);
});
