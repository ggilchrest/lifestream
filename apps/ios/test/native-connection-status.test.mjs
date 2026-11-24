import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,copyFile,writeFile,readFile,readdir,lstat,realpath} from 'node:fs/promises';import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';import {join,relative,isAbsolute,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';

test('actual NativeTransport drives connection light from current authenticated HTTP and socket lifecycle',{timeout:45000},async t=>{
 const out=await mkdtemp(join(tmpdir(),'lifestream-connection-')),evidence=process.env.CONNECTION_STATUS_EVIDENCE,results=[];t.after(()=>rm(out,{recursive:true,force:true}));const ios=fileURLToPath(new URL('../',import.meta.url)),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 // Exact actual swift-build arm64/macOS Debug layout; no legacy fallback,
 // product staging, aggregate/member double-link, package call or Core rebuild.
 const receiptPath=process.env.ASSISTANT_CORE_BUILD_RECEIPT,scratchRoot=process.env.ASSISTANT_CORE_SCRATCH_ROOT;
 assert.ok(receiptPath&&scratchRoot,'verified original Core build receipt and owned scratch root required');
 const receiptBytes=await readFile(receiptPath);assert.ok(receiptBytes.length<=512*1024,'bounded Core receipt');
 const coreReceipt=JSON.parse(receiptBytes);assert.equal(coreReceipt.kind,'AssistantCore-build-products-v2');assert.equal(coreReceipt.layout,'swift-build-arm64-macos-debug-v1');assert.equal(coreReceipt.target,'AssistantCore');assert.equal(coreReceipt.configuration,'debug');assert.equal(coreReceipt.architecture,'arm64');assert.equal(coreReceipt.targetTriple,'arm64-apple-macos13.0');
 assert.equal(coreReceipt.build?.exitCode,0);assert.equal(coreReceipt.build?.knownClosed,true);assert.deepEqual([...coreReceipt.conditions].sort(),['DEBUG','LIFESTREAM_NATIVE_RECOVERY_DISABLED','SWIFT_PACKAGE'].sort());
 const packageRoot=await realpath(join(ios,'native')),scratch=await realpath(scratchRoot),products=await realpath(coreReceipt.productRoot);assert.equal(coreReceipt.packageRoot,packageRoot);assert.equal(products,scratch,'only the exact preserved successful scratch tree is accepted');
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 const validRelative=value=>typeof value==='string'&&value.length>0&&!isAbsolute(value)&&!value.split('/').some(x=>x==='..'||x==='.'||x==='')&&!value.includes('\\')&&!value.includes('\0');
 async function verifyFile(root,path,expected){
  assert.ok(validRelative(path),'safe relative pinned file');assert.ok(expected&&Number.isSafeInteger(expected.bytes)&&expected.bytes>0&&expected.bytes<=128*1024*1024&&/^[a-f0-9]{64}$/.test(expected.sha256),'bounded exact pin');
  const file=join(root,path),info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1,'independent regular pinned file');assert.equal(info.size,expected.bytes);assert.equal(digest(await readFile(file)),expected.sha256);return file;
 }
 async function files(root){
  const found=[];async function walk(dir){for(const entry of await readdir(join(root,dir),{withFileTypes:true})){assert.ok(!entry.isSymbolicLink(),'no target/product symlink traversal');const path=dir?dir+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(path);else{assert.ok(entry.isFile());found.push(path);assert.ok(found.length<=4096)}}}await walk('');return found.sort();
 }
 assert.equal(digest(await readFile(fileURLToPath(import.meta.url))),coreReceipt.consumerFixture.sha256,'receipt belongs to this corrected fixture');
 await verifyFile(packageRoot,'Package.swift',coreReceipt.package);
 const prefix='Sources/AssistantCore/',resourcePrefix=prefix+'Resources/',targetFiles=(await files(join(packageRoot,prefix))).map(x=>prefix+x),sourcePaths=targetFiles.filter(x=>x.endsWith('.swift')&&!x.startsWith(resourcePrefix)),resourcePaths=targetFiles.filter(x=>x.startsWith(resourcePrefix));
 assert.equal(sourcePaths.length,59);assert.equal(resourcePaths.length,2);assert.deepEqual(Object.keys(coreReceipt.sourceFiles).sort(),sourcePaths);assert.deepEqual(Object.keys(coreReceipt.resourceFiles).sort(),resourcePaths);
 for(const path of sourcePaths)await verifyFile(packageRoot,path,coreReceipt.sourceFiles[path]);for(const path of resourcePaths)await verifyFile(packageRoot,path,coreReceipt.resourceFiles[path]);
 assert.equal(coreReceipt.module.path,'out/Products/Debug/AssistantCore.swiftmodule/arm64-apple-macos.swiftmodule');assert.equal(coreReceipt.moduleSearchPath,'out/Products/Debug');await verifyFile(products,coreReceipt.module.path,coreReceipt.module);
 const objectRoot='out/Intermediates.noindex/AssistantCore.build/Debug/AssistantCore-t.build/Objects-normal/arm64';assert.equal(coreReceipt.objectRoot,objectRoot);
 for(const pin of Object.values(coreReceipt.metadata))await verifyFile(products,pin.path,pin);
 const accessor=coreReceipt.generatedAccessor;assert.equal(accessor.path,'out/Intermediates.noindex/AssistantCore.build/Debug/AssistantCore-t.build/DerivedSources/resource_bundle_accessor.swift');await verifyFile(products,accessor.path,accessor);
 const expectedSources=[...sourcePaths.map(x=>join(packageRoot,x)),join(products,accessor.path)].sort();
 const listed=(await readFile(join(products,coreReceipt.metadata.fileList.path),'utf8')).trimEnd().split(/\r?\n/).map(line=>{const value=line.replaceAll('\\ ',' ');assert.equal(value.includes('\\'),false,'only verified space escaping in original SwiftFileList');return value});assert.deepEqual([...listed].sort(),expectedSources);
 const outputMap=JSON.parse(await readFile(join(products,coreReceipt.metadata.outputFileMap.path),'utf8'));assert.deepEqual(Object.keys(outputMap).filter(Boolean).sort(),expectedSources);
 const mapped=expectedSources.map(path=>outputMap[path]?.object);assert.ok(mapped.every(path=>typeof path==='string'&&path.startsWith(join(products,objectRoot)+'/')));assert.equal(new Set(mapped).size,60);
 const linked=(await readFile(join(products,coreReceipt.metadata.linkFileList.path),'utf8')).trimEnd().split(/\r?\n/);assert.deepEqual([...linked].sort(),[...mapped].sort());
 const objectPaths=(await files(join(products,objectRoot))).filter(x=>x.endsWith('.o')).map(x=>objectRoot+'/'+x);assert.equal(objectPaths.length,60);assert.deepEqual([...objectPaths].sort(),mapped.map(x=>relative(products,x)).sort());assert.deepEqual(Object.keys(coreReceipt.objects).sort(),[...objectPaths].sort());assert.ok(objectPaths.includes(objectRoot+'/resource_bundle_accessor.o'));
 const coreObjects=[];for(const path of objectPaths)coreObjects.push(await verifyFile(products,path,coreReceipt.objects[path]));assert.equal(coreObjects.includes(join(products,'out/Products/Debug/AssistantCore.o')),false,'aggregate and members must never both be linked');
 for(const pin of Object.values(coreReceipt.processedResources))await verifyFile(products,pin.path,pin);
 for(const [path,pin] of Object.entries(coreReceipt.nativeInputs))await verifyFile(ios,path,pin);
 const verifiedCore={receiptSHA256:digest(receiptBytes),packageRoot,productRoot:products,sourceCount:59,resourceCount:2,objectCount:60,target:'AssistantCore',completeOriginalTarget:true,priorBuildKnownClosed:true,actualCompilerArgvSHA256:coreReceipt.build.actualCompilerArgvSHA256};
 if(evidence)await writeFile(join(evidence,'CORE-PRODUCTS-VERIFIED.json'),JSON.stringify(verifiedCore,null,2)+'\n');
 async function run(name,executable,argv,timeout){
  const startedAtUTC=new Date().toISOString(),start=performance.now();
  const result=spawnSync(executable,argv,{encoding:'utf8',timeout});
  let pidState='not_started';if(Number.isInteger(result.pid)&&result.pid>0){try{process.kill(result.pid,0);pidState='present_unresolved'}catch(error){pidState=error.code==='ESRCH'?'absent':'uncertain'}}
  const code=result.error?.code,errorCode=code===undefined?null:['ETIMEDOUT','ENOENT','EACCES','ENOBUFS'].includes(code)?code:'other';
  const metadata={name,executable,argv,startedAtUTC,finishedAtUTC:new Date().toISOString(),elapsedMs:Math.round(performance.now()-start),limitMs:timeout,pid:result.pid??null,exitCode:result.status??null,signal:result.signal??null,errorCode,timedOut:code==='ETIMEDOUT',spawnSyncReturned:true,pidState,knownClosed:pidState==='absent'||pidState==='not_started'};
  results.push(metadata);
  if(evidence){await writeFile(join(evidence,name+'.stdout.log'),result.stdout??'');await writeFile(join(evidence,name+'.stderr.log'),result.stderr??'');await writeFile(join(evidence,'INNER-RESULTS.json'),JSON.stringify({steps:results,syntheticPeerRequired:true,coreProducts:verifiedCore},null,2)+'\n')}
  assert.equal(metadata.knownClosed,true,name+': inner process closure unresolved');
  assert.equal(result.status,0,name+': '+(result.stderr??''));return result;
 }
 await copyFile(new URL('./connection-status-probe.swift',import.meta.url),join(out,'main.swift'));
 await run('native-compile','/usr/bin/xcrun',['swiftc','-DDEBUG','-DLIFESTREAM_NATIVE_RECOVERY_DISABLED','-swift-version','5','-target',coreReceipt.targetTriple,'-sdk',coreReceipt.sdkPath,'-I',join(products,coreReceipt.moduleSearchPath),...coreObjects,join(native,'ConnectionStore.swift'),join(native,'NativeTransport.swift'),join(out,'main.swift'),'-o',join(out,'probe')],20000);
 const result=await run('native-probe',join(out,'probe'),[],8000);
 assert.match(result.stdout,/native connection lifecycle passed/);
 const phases=result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));assert.ok(phases.some(x=>x.event==='session_bound'&&x.phase==='restore_session_bound'),'restore interceptor binding recorded');assert.equal(phases.at(-1)?.event,'completed');assert.equal(phases.at(-1)?.rejectedRequests,0);assert.equal(phases.at(-1)?.sessionBindings,4);
});
