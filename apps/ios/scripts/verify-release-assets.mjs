// Fail-closed, offline all-assets release gate. All outputs remain outside Git.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {createServer} from 'node:http';
import {releaseAppearancePlan,contextLossResultAccepted} from './release-asset-probe.js';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert(args[i]?.startsWith('--')&&args[i+1],'Use named path arguments.');options[args[i].slice(2)]=resolve(args[i+1]);}
for(const name of ['source','public','expected-catalog','expected-audio','output','dependencies'])assert(options[name],`Missing --${name}`);
const source=await realpath(options.source),root=await realpath(options.public),out=options.output;
for(let p=out;;p=dirname(p)){try{await lstat(join(p,'.git'));throw Error('Release evidence must be outside Git.');}catch(error){if(error.code!=='ENOENT')throw error;}if(dirname(p)===p)break;}
await mkdir(out,{recursive:false,mode:0o700});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async path=>{const full=resolve(root,path),actual=await realpath(full);assert(actual===full&&!relative(root,actual).startsWith('..'+sep),'Asset must be a regular in-package file.');assert((await lstat(full)).isFile());return readFile(full);};
const expected=await readFile(options['expected-catalog']),catalogBytes=await read('bundled-appearances.json');
assert.equal(sha(catalogBytes),sha(expected),'Packaged catalog differs from the independently selected required catalog.');
const catalog=JSON.parse(catalogBytes),manifest=JSON.parse(await read('shared-renderer-manifest.json'));
assert(Array.isArray(catalog.packages)&&catalog.neutral?.id==='neutral');
const plan=releaseAppearancePlan(JSON.parse(expected));
const expectedRendererFiles=['animation-playlist.js','presentation-runtime.js','presentation-core.js','presentation-motion.js','presentation-speech.js','presentation-state.js','presentation-trusted-adapter.js','packages/runtime/src/embodiment/controller.ts'];
assert.deepEqual(manifest.shared.map(x=>x.path).sort(),expectedRendererFiles.sort(),'Renderer inventory is incomplete.');
for(const pin of manifest.shared){const path=pin.path.startsWith('packages/')?pin.path:'apps/control-web/'+pin.path;assert.equal(sha(await readFile(join(source,path))),pin.sha256,`Renderer source pin mismatch: ${pin.path}`);}
const declared=new Set(),assetPins={};
for(const item of catalog.packages){
 for(const resource of item.manifest.resources){const path=`appearances/${item.id}/${resource.path}`,bytes=await read(path);assert.equal(bytes.length,resource.bytes);assert.equal(sha(bytes),resource.sha256);declared.add(path);assetPins[path]=sha(bytes);}
 if(item.manifest.schemaVersion==='1.5.0'){assert.equal(item.trustedRuntime?.kind,'world-delta.v1');const path=`appearances/adapters/world-delta.v1/${item.id}/${item.digest}.js`,bytes=await read(path);assert.equal(bytes.length,item.trustedRuntime.bytes);assert.equal(sha(bytes),item.trustedRuntime.sha256);declared.add(path);assetPins[path]=sha(bytes);}
}
const packaged=new Set();
async function collect(directory,prefix='appearances'){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const name=prefix+'/'+entry.name;assert(!entry.isSymbolicLink(),'Packaged assets cannot be symlinks.');
  if(entry.isDirectory())await collect(join(directory,entry.name),name);
  else {assert(entry.isFile()&&declared.has(name),'Unlisted file in packaged appearance resources.');packaged.add(name);}
 }
}
if(declared.size){await collect(join(root,'appearances'));assert.deepEqual([...packaged].sort(),[...declared].sort());}
const wav=await read('audio-probe.wav');assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');assert.equal(wav.readUInt16LE(20),1);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(24),48000);assert.equal(wav.readUInt16LE(34),16);
assert.equal(sha(wav),sha(await readFile(options['expected-audio'])),'Packaged audio differs from the independently selected test clip.');
const require=createRequire(join(options.dependencies,'..','release-check.cjs')),{build}=require('esbuild'),{chromium}=require('playwright');
const entry=fileURLToPath(new URL('./release-asset-probe.js',import.meta.url));
const plugins=()=>[{name:'same-shared-loaders',setup(b){b.onResolve({filter:/^\.\/behavior-controller\.js$/},()=>({path:join(source,'packages/runtime/src/embodiment/controller.ts')}));b.onResolve({filter:/^\.\/(GLTFLoader|RoomEnvironment)\.js$/},args=>({path:join(options.dependencies,'three/examples/jsm',args.path.includes('GLTF')?'loaders/GLTFLoader.js':'environments/RoomEnvironment.js')}));}}];
const product=await build({entryPoints:[join(source,'apps/ios/web/app.js')],outfile:join(source,'apps/ios/dist/app.js'),bundle:true,format:'esm',minify:true,legalComments:'eof',write:false,metafile:true,nodePaths:[options.dependencies],plugins:plugins()});
assert.equal(product.outputFiles.length,1);assert.equal(sha(product.outputFiles[0].contents),sha(await read('app.js')),'Packaged app.js does not contain the tested renderer source.');
await writeFile(join(out,'product-inputs.json'),JSON.stringify(product.metafile,null,2)+'\n',{mode:0o600});
const probe=await build({stdin:{contents:`import {MobilePresentationRuntime} from ${JSON.stringify(join(source,'apps/ios/web/mobile-presentation-runtime.js'))};import {bundledAppearances,bundledResource} from ${JSON.stringify(join(source,'apps/ios/web/bundled-appearances.js'))};import {installAssetProbe} from ${JSON.stringify(entry)};installAssetProbe({MobilePresentationRuntime,bundledAppearances,bundledResource});`,resolveDir:source,sourcefile:'release-asset-entry.js'},bundle:true,format:'esm',write:false,metafile:true,nodePaths:[options.dependencies],plugins:plugins()});
await writeFile(join(out,'probe.js'),probe.outputFiles[0].contents,{mode:0o600});
await writeFile(join(out,'probe-inputs.json'),JSON.stringify(probe.metafile,null,2)+'\n',{mode:0o600});
const csp=(await read('index.html')).toString().match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];assert(csp,'Packaged Content Security Policy is absent.');
const html='<!doctype html><meta charset="utf-8">'+csp+'<link rel="stylesheet" href="/__release-probe.css"><canvas></canvas><script type="module" src="/__release-probe.js"></script>';
const server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}if(path==='/__release-probe.css'){res.setHeader('Content-Type','text/css');res.end('html,body{margin:0;background:#111f2e}canvas{width:390px;height:640px;display:block}');return;}if(path==='/__release-probe.js'){res.setHeader('Content-Type','text/javascript');res.end(probe.outputFiles[0].contents);return;}if(path==='/favicon.ico'){res.writeHead(204).end();return;}const name=path.slice(1),bytes=await read(name);res.setHeader('Content-Type',name.endsWith('.json')?'application/json':name.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(bytes);}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let browser,browserVersion,contextLossCheck=plan.contextLossAdapterId===null?{status:'notApplicable',reason:'The independent required inventory contains no adapter appearance.'}:{status:'notRun'};const results=[],transitions=[],errors=[],warnings=[],blocked=[];
const watchdog=setTimeout(()=>{void browser?.close();},180000);
try{
 browser=await chromium.launch({headless:true,...(options.browser?{executablePath:options.browser}:{}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking','--js-flags=--expose-gc']});browserVersion=browser.version();
 const context=await browser.newContext({viewport:{width:390,height:640}});
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/'))return route.continue();blocked.push(url);return route.abort();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
 await page.goto(origin);await page.waitForFunction(()=>globalThis.assetProbeReady,{timeout:30000});
 for(const pair of plan.transitionPairs){
  try{transitions.push(await page.evaluate(pair=>globalThis.checkAppearanceTransition(pair),pair));await page.locator('canvas').screenshot({path:join(out,`transition-${transitions.length-1}.png`)});}
  catch(error){transitions.push({...pair,status:'failed',error:error.message});break;}
 }
 await page.evaluate(()=>globalThis.releaseAppearance());
 const appearances=plan.appearanceIds.map(id=>[catalog.neutral,...catalog.packages].find(item=>item.id===id));
 for(const item of appearances){
  const start=Date.now();let result;
  try{result=await page.evaluate(id=>globalThis.checkAppearance(id),item.id);await page.locator('canvas').screenshot({path:join(out,`appearance-${results.length}.png`)});result={...result,status:'passed'};}
  catch(error){result={id:item.id,status:'failed',error:error.message};}
  results.push({...result,milliseconds:Date.now()-start});
  if(item.id===plan.contextLossAdapterId&&result.status==='passed'){
   try{contextLossCheck={...await page.evaluate(()=>globalThis.checkContextLoss()),id:item.id};}
   catch(error){contextLossCheck={status:'failed',id:item.id,error:error.message};}
  }else await page.evaluate(()=>globalThis.releaseAppearance());
 }
}finally{clearTimeout(watchdog);await browser?.close();await new Promise(resolve=>server.close(resolve));}
const relevantWarnings=warnings.filter(text=>!/GPU stall due to ReadPixels/.test(text));
const contextLossAccepted=contextLossResultAccepted(plan.contextLossAdapterId,contextLossCheck);
const report={recordedAtUTC:new Date().toISOString(),status:results.every(x=>x.status==='passed')&&transitions.length===plan.transitionPairs.length&&transitions.every(x=>x.status==='passed')&&contextLossAccepted&&!errors.length&&!relevantWarnings.length&&!blocked.length?'passed':'failed',publicRoot:root,sourceRoot:source,expectedCatalogSHA256:sha(expected),packagedAppJSSHA256:sha(await read('app.js')),packagedAppMatchesRecompiledProduct:true,rendererManifestSHA256:sha(await read('shared-renderer-manifest.json')),contentSecurityPolicySHA256:sha(csp),assetPins,requiredTransitionPairs:plan.transitionPairs,transitions,audioProbeSHA256:sha(wav),results,requiredContextLossAdapter:plan.contextLossAdapterId,contextLossCheck,contextLossAccepted,pageErrors:errors,warnings,relevantWarnings,blockedExternalRequests:blocked,actualBrowser:{version:browserVersion,executable:options.browser??'Playwright pinned Chromium',kind:'WebGL via Playwright; actual GLTFLoader and approved blob adapter modules'},noServerOrMicrophoneActions:true};
await writeFile(join(out,'RESULTS.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:report.status,transitions:transitions.map(x=>({from:x.from,to:x.to,status:x.status,error:x.error})),appearances:results.map(x=>({id:x.id,status:x.status,animations:x.declaredAnimationsTested?.length,error:x.error})),pageErrors:errors,relevantWarnings,blockedExternalRequests:blocked.length}));
if(report.status!=='passed')process.exitCode=1;
