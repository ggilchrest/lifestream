import {mkdir,readFile,writeFile,lstat,realpath,copyFile,readdir} from 'node:fs/promises';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,path)=>{const local=relative(root,path);return local!==''&&local!=='..'&&!local.startsWith('..'+sep);};
function localPath(value){if(typeof value!=='string'||!value||value.includes('\\')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid relative input path.');return value;}
export async function outsideGit(path){
 let actual=resolve(path),suffix=[];
 while(true){try{actual=await realpath(actual);break;}catch(e){if(e.code!=='ENOENT')throw e;suffix.unshift(actual.slice(dirname(actual).length+1));const parent=dirname(actual);if(parent===actual)throw e;actual=parent;}}
 for(let dir=(await lstat(actual)).isDirectory()?actual:dirname(actual);;dir=dirname(dir)){
  try{await lstat(join(dir,'.git'));throw Error('Output and private inputs must be outside every Git root.');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(dirname(dir)===dir)break;
 }
 return resolve(actual,...suffix);
}
async function regular(root,path){
 path=localPath(path);const target=join(root,path);
 for(let cursor=target;cursor!==root;cursor=dirname(cursor))if((await lstat(cursor)).isSymbolicLink())throw Error('Symlink input refused.');
 if(!inside(root,await realpath(target))||!(await lstat(target)).isFile())throw Error('Input must be a regular in-root file.');
 return target;
}
async function pinned(path,digest){if(!/^[a-f0-9]{64}$/.test(digest))throw Error('An exact SHA256 input pin is required.');const bytes=await readFile(path);if(sha(bytes)!==digest)throw Error('Input pin mismatch.');return bytes;}
export async function validateNativeSnapshot(sourceRoot,manifest,manifestSHA256){
 const source=await realpath(sourceRoot),bytes=await pinned(manifest,manifestSHA256),document=JSON.parse(bytes);
 if(document.schemaVersion!=='1.0.0'||!document.files||Array.isArray(document.files)||!Object.keys(document.files).length)throw Error('Closed explicit source file map required.');
 const entries=[];
 for(const [path,digest]of Object.entries(document.files)){
  localPath(path);
  if(!/^apps\/ios\/(?:ios\/(?:App\/(?:App\/|App\.xcodeproj\/|CapApp-SPM\/)|debug\.xcconfig$)|native\/(?:Package\.swift$|Sources\/|Tests\/)|capacitor\.config\.json$)/.test(path)||path.split('/').some(p=>['.git','.build','.swiftpm','xcuserdata','public','node_modules'].includes(p)))throw Error('Unexpected native snapshot input.');
  const input=await regular(source,path);await pinned(input,digest);entries.push([path,input,digest]);
 }
 for(const required of ['apps/ios/ios/App/App.xcodeproj/project.pbxproj','apps/ios/ios/App/App/Info.plist','apps/ios/ios/App/CapApp-SPM/Package.swift','apps/ios/native/Package.swift','apps/ios/capacitor.config.json','apps/ios/ios/App/CapApp-SPM/Sources/CapApp-SPM/NativeCalendarAppComposition.swift'])if(!document.files[required])throw Error('Incomplete explicit native snapshot.');
 return {source,entries,manifestSHA256};
}
export async function acceptedPrivateInputs({gatePath,gateSHA256}){
 await outsideGit(gatePath);const gate=JSON.parse(await pinned(gatePath,gateSHA256));
 if(gate.baselineBundleIdentifier!=='org.lifestream.assistant'||gate.baselineVersion!=='0.1.0')throw Error('Unexpected bundle identity.');
 const publicRoot=await realpath(join(gate.baselineSignedExportApp,'public'));await outsideGit(publicRoot);
 const catalogBytes=await pinned(await regular(publicRoot,'bundled-appearances.json'),gate.baselineCatalogSHA256),catalog=JSON.parse(catalogBytes),files=new Map();
 let resources=0,adapters=0,animations=0;
 if(catalog.packages.length!==gate.baselineAppearancePackages)throw Error('Appearance package count mismatch.');
 const add=async(path,digest,size)=>{if(files.has(path))throw Error('Duplicate private payload path.');const source=await regular(publicRoot,path),bytes=await pinned(source,digest);if(size!==undefined&&bytes.length!==size)throw Error('Private payload size mismatch.');files.set(path,{source,sha256:digest,bytes:bytes.length});};
 for(const item of catalog.packages){
  localPath(item.id);if(item.id.includes('/'))throw Error('Invalid package identity.');
  for(const resource of item.manifest.resources){await add('appearances/'+item.id+'/'+localPath(resource.path),resource.sha256,resource.bytes);resources++;}
  animations+=(item.manifest.animationLibrary??[]).length;
  if(item.trustedRuntime){if(!/^[a-f0-9]{64}$/.test(item.digest))throw Error('Invalid appearance digest.');await add('appearances/adapters/world-delta.v1/'+item.id+'/'+item.digest+'.js',item.trustedRuntime.sha256,item.trustedRuntime.bytes);adapters++;}
 }
 if(files.size!==gate.baselineAppearancePayloadFileCount||resources!==gate.baselineDeclaredResourceFiles||adapters!==gate.baselineMotionAdapters||animations!==gate.baselineDeclaredAnimationEntries)throw Error('Private payload inventory mismatch.');
 const renderer=JSON.parse(await readFile(await regular(publicRoot,'shared-renderer-manifest.json')));
 if(renderer.shared.length!==8||renderer.privateAssetsIncluded!==true)throw Error('Accepted shared renderer manifest required.');
 const payloadMap=Object.fromEntries([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,value])=>[path,value.sha256]));
 if(sha(JSON.stringify(payloadMap))!==gate.baselineAppearancePayloadMapSHA256)throw Error('Accepted private payload map mismatch.');
 await add('audio-probe.wav',gate.baselineRequiredDiagnosticClipSHA256);
 await pinned(gate.existingVerifier,gate.existingVerifierSHA256);
 return {gate,publicRoot,catalogBytes,files,renderer,counts:{resources,adapters,animations}};
}
export async function leafManifest(root){
 const files={};async function walk(directory){for(const name of (await readdir(directory)).sort()){const path=join(directory,name),info=await lstat(path);if(info.isSymbolicLink())throw Error('Symlink output refused.');if(info.isDirectory())await walk(path);else if(info.isFile())files[relative(root,path).split(sep).join('/')]=sha(await readFile(path));else throw Error('Unexpected output type.');}}await walk(root);return files;
}
export async function prepareCalendarNative({sourceRoot,manifest,manifestSHA256,gatePath,gateSHA256,output,flavor,buildNumber}){
 if(!['regular','recovery'].includes(flavor)||!Number.isSafeInteger(buildNumber)||buildNumber<1)throw Error('Explicit flavor and build number required.');
 const snapshot=await validateNativeSnapshot(sourceRoot,manifest,manifestSHA256),privateInputs=await acceptedPrivateInputs({gatePath,gateSHA256});
 const reviewedInputs=JSON.parse(await readFile(manifest)).reviewedInputs;
 if(!reviewedInputs||!reviewedInputs['apps/ios/scripts/build-web.mjs'])throw Error('Explicit reviewed build inputs required.');
 const verifyReviewed=async()=>{for(const [path,digest]of Object.entries(reviewedInputs))await pinned(await regular(snapshot.source,path),digest);};
 await verifyReviewed();
 output=await outsideGit(output);if(inside(snapshot.source,output)||output===snapshot.source)throw Error('Output must be isolated from source.');
 try{await lstat(output);throw Error('Existing output is preserved; choose a new directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(output,{recursive:true});
 for(const [path,input,digest]of snapshot.entries){const target=join(output,path.slice('apps/ios/'.length));await mkdir(dirname(target),{recursive:true});const bytes=await pinned(input,digest);await writeFile(target,bytes);}
 const config=JSON.parse(await readFile(join(output,'capacitor.config.json')));config.packageClassList=[];
 await writeFile(join(output,'ios/App/App/capacitor.config.json'),JSON.stringify(config,null,2)+'\n');
 await writeFile(join(output,'ios/App/App/config.xml'),'<?xml version="1.0" encoding="utf-8"?>\n<widget version="1.0.0" xmlns="http://www.w3.org/ns/widgets"></widget>\n');
 if(flavor==='recovery'){
  const path=join(output,'ios/App/CapApp-SPM/Package.swift'),source=await readFile(path,'utf8'),needle='            ]\n        )';
  if(source.split(needle).length!==2)throw Error('Unexpected reviewed SPM target layout.');
  await writeFile(path,source.replace(needle,'            ],\n            swiftSettings: [.define("LIFESTREAM_NATIVE_RECOVERY_DISABLED")]\n        )'));
 }
 const publicRoot=join(output,'ios/App/App/public');
 // Use the reviewed renderer builder, with no private package discovery or data.
 const {buildWeb}=await import(pathToFileURL(join(snapshot.source,'apps/ios/scripts/build-web.mjs')));
 await buildWeb(publicRoot);await verifyReviewed();
 const renderer=JSON.parse(await readFile(join(publicRoot,'shared-renderer-manifest.json')));
 if(JSON.stringify(renderer.shared)!==JSON.stringify(privateInputs.renderer.shared))throw Error('Reviewed renderer differs from accepted private bundle.');
 renderer.privateAssetsIncluded=true;await writeFile(join(publicRoot,'shared-renderer-manifest.json'),JSON.stringify(renderer,null,2)+'\n');
 await writeFile(join(publicRoot,'bundled-appearances.json'),privateInputs.catalogBytes);
 for(const [path,value]of privateInputs.files){const target=join(publicRoot,path);await mkdir(dirname(target),{recursive:true});await copyFile(value.source,target);await pinned(target,value.sha256);}
 const receipt={schemaVersion:'1.0.0',flavor,buildNumber,bundleIdentifier:privateInputs.gate.baselineBundleIdentifier,version:privateInputs.gate.baselineVersion,sourceManifestSHA256:manifestSHA256,gateSHA256,acceptedBaselineBuild:privateInputs.gate.baselineBuild,privateCounts:privateInputs.counts,signatureVerified:false,installed:false,recoveryCompileDefine:flavor==='recovery'?'LIFESTREAM_NATIVE_RECOVERY_DISABLED':null,snapshotPolicy:'lifestream-native-mobile-context-store/1',snapshotLocator:'Library/Application Support/Lifestream/mobile-context.snapshot.json'};
 await writeFile(join(output,'PREPARATION-RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n');
 return {output,project:join(output,'ios/App/App.xcodeproj'),publicRoot,receipt,verifier:privateInputs.gate.existingVerifier,baselinePublic:privateInputs.publicRoot};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const options=JSON.parse(await readFile(process.argv[2]));console.log(JSON.stringify(await prepareCalendarNative(options),null,2));}
