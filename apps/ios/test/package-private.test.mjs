import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {copyNativeSources,nativeSourceFiles} from '../scripts/package-private.mjs';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'mobile-source-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const repo=join(directory,'repo'),source=join(repo,'apps/ios'),output=join(directory,'output');await mkdir(source,{recursive:true});
 const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 git('init','--quiet');
 const put=async(file,bytes)=>{const path=join(source,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);};
 return {directory,repo,source,output,git,put};
}

test('private source copy preserves tracked work and includes new native Swift sources',async t=>{
 const f=await fixture(t);
 const tracked=['ios/App/App/AppDelegate.swift','ios/App/App.xcodeproj/project.pbxproj','ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png','native/Package.swift'];
 for(const file of tracked)await f.put(file,'tracked '+file);
 await f.put('native/.swiftpm/user-state','local user state');
 f.git('add','.');
 await f.put(tracked[0],'uncommitted application edit');
 const added=['ios/App/CapApp-SPM/Sources/CapApp-SPM/NativePlaybackProbe.swift','native/Sources/AssistantCore/PlaybackBuffer.swift','native/Sources/AssistantCore/PlaybackPCM.swift','native/Tests/AssistantCoreTests/PlaybackBufferTests.swift','ios/App/App/NewView.swift'];
 for(const file of added)await f.put(file,'new source '+file);
 const expected=[...tracked,...added].sort();
 assert.deepEqual(await copyNativeSources(f.output,f.source),expected);
 for(const file of expected)assert.deepEqual(await readFile(join(f.output,file)),await readFile(join(f.source,file)));
 assert.equal(await readFile(join(f.source,tracked[0]),'utf8'),'uncommitted application edit');
 assert.match(f.git('status','--porcelain').toString(),/NativePlaybackProbe|Sources/);
 await assert.rejects(stat(join(f.output,'native/.swiftpm/user-state')),{code:'ENOENT'});
});

test('private source copy excludes ignored sources, unrelated untracked files and generated state',async t=>{
 const f=await fixture(t);
 await f.put('.gitignore','native/Sources/AssistantCore/Ignored.swift\nios/App/App/public/\n');
 const excluded=['native/Sources/AssistantCore/Ignored.swift','native/Sources/AssistantCore/private.wav','native/Sources/AssistantCore/credentials.json','ios/App/App/Assets.xcassets/private.png','ios/App/App/public/private.swift','ios/App/App/xcuserdata/User.swift','native/.build/Generated.swift','native/.swiftpm/State.swift','native/Other.swift','ios/notes.swift'];
 for(const file of excluded)await f.put(file,'do not copy');
 const included='native/Sources/AssistantCore/New.swift';await f.put(included,'new source');
 assert.deepEqual(await copyNativeSources(f.output,f.source),[included]);
 for(const file of excluded)await assert.rejects(stat(join(f.output,file)),{code:'ENOENT'});
});

test('private source copy rejects symlinks instead of reading outside source inputs',async t=>{
 const f=await fixture(t),file='native/Sources/AssistantCore/Linked.swift';
 await mkdir(dirname(join(f.source,file)),{recursive:true});await writeFile(join(f.directory,'outside.swift'),'outside content');
 await symlink(join(f.directory,'outside.swift'),join(f.source,file));
 await assert.rejects(nativeSourceFiles(f.source),/regular files inside the source/);
 await assert.rejects(copyNativeSources(f.output,f.source),/regular files inside the source/);
 await assert.rejects(stat(f.output),{code:'ENOENT'});
});
