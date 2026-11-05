import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bundleWeb} from '../scripts/build-web.mjs';

test('packaged mobile bundle retains the redesigned conversation and its settings features',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ios-redesign-package-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');const output=join(dir,'app.js');await bundleWeb({outfile:output});const script=await readFile(output,'utf8');
 for(const id of ['open-settings','close-settings','main-pane','settings-pane','text-chat','start','stop','send-text','history-list','voice-load','voice-reference','audio-diagnostics','verbose-diagnostics','share-audit-diagnostics','animation-selector','physics-options']){
  assert.match(html,new RegExp(`id="${id}"`),`packaged HTML is missing ${id}`);
 }
 for(const feature of ['voice-load','history-list','share-audit-diagnostics','physics-options','personalSessionPolicy','pendingPersonalLock'])assert.ok(script.includes(feature),`packaged JS is missing ${feature}`);
 assert.match(html,/<details id="audio-diagnostics"/);assert.ok(html.indexOf('id="settings-pane"')<html.indexOf('id="audio-diagnostics"'));
 assert.ok(html.indexOf('id="text-chat"')<html.indexOf('id="settings-pane"'));
});
