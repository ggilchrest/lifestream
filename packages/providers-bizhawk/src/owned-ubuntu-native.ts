import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join} from 'node:path';
import {listenForNativeBizHawk,nativeBridgeEnvironment} from './native-host.ts';
import {NativeGameEvidence} from './native-evidence.ts';

/** Existing native transport/evidence APIs, with an owned Ubuntu Mono child.
 * Supplied pairing is consumed only on an explicitly started run. This source
 * neither discovers a key/session nor creates a display or installation. */
export function createOwnedUbuntuNative(options:any,testBoundary?:any){
 if(!testBoundary&&process.platform!=='linux')throw Error('Ubuntu native host requires Linux');
 const paths=['mono','emulator','configFile','entryFile','romFile','guiProbe'];
 const installed=Object.fromEntries(paths.map(name=>{
  const path=options[name];if(!isAbsolute(path??''))throw Error('Explicit owned native path required: '+name);
  const actual=realpathSync(path);if(actual!==path||!lstatSync(path).isFile())throw Error('Canonical native file required');
  if(!options.evidence.sourceFiles.some((pin:any)=>pin.path===path))throw Error('Native source pin missing: '+name);
  return [name,path];
 }));
 for(const file of ['peer.lua','utc-expiry.lua'])if(!options.evidence.sourceFiles.some((pin:any)=>pin.path===join(dirname(installed.entryFile!),file)))throw Error('Native Lua dependency pin missing: '+file);
 const config=JSON.parse(readFileSync(installed.configFile!,'utf8').replace(/^\uFEFF/,''));
 if(config.StartPaused!==true||config.AutoLoadLastSaveSlot!==false||config.AutoSaveLastSaveSlot!==false||config.AutosaveSaveRAM!==false||config.Rewind?.Enabled!==false||config.PreferredCores?.SNES!=='Snes9x'||config.DontTryOtherCores!==true)throw Error('Owned continuation startup configuration unavailable');
 const evidence=(testBoundary?.createEvidence??((input:any)=>new NativeGameEvidence(input)))(options.evidence);
 let host:any,transport:any,child:any,lastAction:any=null,closed=false,confirmed=false,shutdownPromise:Promise<boolean>|undefined,closePromise:Promise<void>|undefined;
 const shutdown=()=>shutdownPromise??=(async()=>{
  if(lastAction&&transport?.safetyRelease){const unavailable=async()=>{throw Error('Safety release only');};confirmed=await evidence.shutdownExactOldLease(lastAction,{observe:unavailable,applyController:unavailable,controlSave:unavailable,releaseControls:transport.safetyRelease},3000);}
  return confirmed;
 })();
 const close=()=>closePromise??=(async()=>{
  closed=true;
  try{await shutdown();}finally{try{await host?.close();}finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),new Promise<void>(resolve=>setTimeout(resolve,1000))]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}}}
 })();
 const openNative=async(boundary:any,context:any,launch:any)=>{
  if(closed||child||context.signal.aborted||!context.isCurrent(options.evidence.scope)||launch.host!=='127.0.0.1')throw Error('Owned native launch fenced');
  const state=readFileSync(launch.continuation.path);
  if(state.length!==launch.continuation.bytes||createHash('sha256').update(state).digest('hex')!==launch.continuation.sha256)throw Error('Owned continuation changed');
  const native={...options.native,port:launch.port,scope:options.evidence.scope,pinsDigest:options.evidence.pinsDigest,boundary,shutdownAdmission:evidence.admitRelease,onDisconnect:()=>{void close();}};
  const abort=()=>{void close();};context.signal.addEventListener('abort',abort,{once:true});
  try{
   host=await (testBoundary?.listen??listenForNativeBizHawk)(native);
   if(context.signal.aborted||!context.isCurrent(options.evidence.scope))throw Error('Native launch fenced');
   child=(testBoundary?.spawn??spawn)(installed.mono!,[installed.emulator!,'--config='+installed.configFile,'--lua='+installed.entryFile,'--load-state='+launch.continuation.path,installed.romFile!],{cwd:dirname(installed.emulator!),env:{...options.environment,...nativeBridgeEnvironment(native),LIFESTREAM_BIZHAWK_EVIDENCE_FILE:evidence.evidenceFile},stdio:'ignore'});
   evidence.bindOwnedProcess(child);child.once('error',abort);child.once('exit',abort);
   transport=await host.connected;await transport.ready;
   const probe=testBoundary?.probe??(async()=>{const {stdout}=await promisify(execFile)(options.python??'python3',[installed.guiProbe!,String(child.pid)],{env:{...options.environment},timeout:2000,maxBuffer:4096});return JSON.parse(stdout);});
   const gui=await probe(child);
   if(closed||child.exitCode!==null||child.signalCode!==null||gui.pid!==child.pid||gui.viewable!==true||!evidence.sourceAvailable(options.evidence.scope,options.evidence.pinsDigest)||context.signal.aborted)throw Error('Owned Ubuntu GUI unavailable');
   // The authenticated transport already applies the final admission boundary.
   const adapter={...transport.adapter,applyController:async(request:any,call:any)=>{lastAction=request;return transport.adapter.applyController(request,call);}};
   return {adapter,close:()=>{context.signal.removeEventListener('abort',abort);void close();}};
  }catch(error){await close();throw error;}
 };
 return Object.freeze({evidence,openNative,shutdownExactOldLease:shutdown,close,get pauseConfirmed(){return confirmed;}});
}
