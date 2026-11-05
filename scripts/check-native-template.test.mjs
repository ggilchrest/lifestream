import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeTemplateSources,verifyNativeTemplate} from './check-native-template.mjs';

test('native source changes fail the build until the exact template pin is updated',t=>{
 const root=mkdtempSync(join(tmpdir(),'native-template-pins-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sources={};for(const [key,file]of Object.entries(nativeTemplateSources)){const bytes=Buffer.from('controlled native source '+key);writeFileSync(join(root,file),bytes);sources[key]=createHash('sha256').update(bytes).digest('hex');}
 const template=join(root,'template.json'),value={schemaVersion:'ct-native-template/1',sources};writeFileSync(template,JSON.stringify(value));verifyNativeTemplate(template,root);
 const changed=Buffer.from('changed peer authority expiry implementation');writeFileSync(join(root,nativeTemplateSources.peer),changed);assert.throws(()=>verifyNativeTemplate(template,root),/source pin is stale: peer/);
 value.sources.peer=createHash('sha256').update(changed).digest('hex');writeFileSync(template,JSON.stringify(value));verifyNativeTemplate(template,root);
 delete value.sources.expiry;writeFileSync(template,JSON.stringify(value));assert.throws(()=>verifyNativeTemplate(template,root));
});
