import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {outsideGit,validateNativeSnapshot,acceptedPrivateInputs,prepareCalendarNative} from '../scripts/prepare-calendar-native.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('private output refuses every Git ancestor, including symlink destinations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'calendar-package-'));await mkdir(join(root,'repo/.git'),{recursive:true});await symlink(join(root,'repo'),join(root,'link'));
 await assert.rejects(outsideGit(join(root,'repo/deep/new')),/outside every Git/);await assert.rejects(outsideGit(join(root,'link/new')),/outside every Git/);
 assert.equal(await outsideGit(join(root,'clean/new')),join(await realpath(root),'clean/new'));
});
test('explicit native inputs reject changed, extra, escaping and symbolic files before output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'calendar-input-'));const file='apps/ios/native/Package.swift';await mkdir(join(root,'apps/ios/native'),{recursive:true});await writeFile(join(root,file),'reviewed');
 const manifest=join(root,'manifest.json');async function run(files){const text=JSON.stringify({schemaVersion:'1.0.0',files});await writeFile(manifest,text);return validateNativeSnapshot(root,manifest,sha(text));}
 await assert.rejects(run({[file]:sha('changed')}),/pin mismatch/);
 await assert.rejects(run({'../escape':sha('reviewed')}),/Invalid relative/);
 await assert.rejects(run({'apps/ios/ios/App/App/public/private':sha('reviewed')}),/Unexpected native/);
 await symlink(join(root,file),join(root,'apps/ios/native/linked'));await assert.rejects(run({'apps/ios/native/Sources/../linked':sha('reviewed')}),/Invalid relative/);
 await mkdir(join(root,'apps/ios/native/Sources'));await symlink(join(root,file),join(root,'apps/ios/native/Sources/link.swift'));await assert.rejects(run({'apps/ios/native/Sources/link.swift':sha('reviewed')}),/Symlink input/);
 await assert.rejects(run({[file]:sha('reviewed')}),/Incomplete explicit/);
});
test('private gate is pinned and required; invalid preparation never creates an output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'calendar-gate-')),gatePath=join(root,'gate.json');await writeFile(gatePath,'{}');
 await assert.rejects(acceptedPrivateInputs({gatePath,gateSHA256:sha('wrong')}),/pin mismatch/);
 await assert.rejects(acceptedPrivateInputs({gatePath,gateSHA256:sha('{}')}),/Unexpected bundle/);
 await assert.rejects(prepareCalendarNative({flavor:'recovery',buildNumber:0}),/Explicit flavor/);
});
