import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const nativeTemplateSources=Object.freeze({supervisor:'c72-native-supervisor.py',entry:'entry.lua',peer:'peer.lua',expiry:'utc-expiry.lua',guiProbe:'ubuntu-gui-probe.py'});
/** Build invariant: changing native code requires the reviewed template pins to
 * change with it. This check never rewrites a template or starts native code. */
export function verifyNativeTemplate(templateFile,nativeDirectory){
 const template=JSON.parse(readFileSync(templateFile,'utf8'));
 assert.equal(template.schemaVersion,'ct-native-template/1');
 assert.deepEqual(Object.keys(template.sources).sort(),Object.keys(nativeTemplateSources).sort());
 for(const [name,file] of Object.entries(nativeTemplateSources)){
  const actual=createHash('sha256').update(readFileSync(join(nativeDirectory,file))).digest('hex');
  assert.equal(template.sources[name],actual,'Native template source pin is stale: '+name);
 }
 return template;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../',import.meta.url));
 verifyNativeTemplate(join(root,'integration/ct-launcher/ct-native-template52.json'),join(root,'packages/providers-bizhawk/native'));
}
