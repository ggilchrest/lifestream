import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import type {GameHostAttach} from '@lifestream/contracts/game-host';
import type {GameAdapterBoundaryOptions} from './provider.js';
import {NativeGameEvidence,type NativeGameEvidenceOptions} from './native-evidence.js';
import {listenForNativeBizHawk,nativeBridgeEnvironment,type NativeGameHostOptions} from './native-host.js';
import {WindowsGameHostClient} from './game-host-client.js';
import type {AuthenticatedGameTransport} from './transport.js';

export interface OwnedWindowsGameHostDriverOptions{
 attach:GameHostAttach;
 fetchAuthenticated:(url:string,init:RequestInit)=>Promise<Response>;
 isScopeCurrent:NativeGameEvidenceOptions['isCurrent'];
 evidence:NativeGameEvidenceOptions;
 native:Omit<NativeGameHostOptions,'scope'|'pinsDigest'|'boundary'|'onDisconnect'|'shutdownAdmission'>;
 emulator:string;configFile:string;entryFile:string;romFile:string;
}
/** Trusted desktop-main construction only. Paths and pairing are approved host
 * configuration, never game/model/renderer messages. No owner grant or consent
 * is created. The final client boundary claims through authenticated /admit. */
export function createOwnedWindowsGameHostDriver(options:OwnedWindowsGameHostDriverOptions){
 if(process.platform!=='win32')throw Error('Owned Windows game host unavailable');
 const paths=[options.emulator,options.configFile,options.entryFile,options.romFile];
 if(paths.some(path=>!isAbsolute(path)))throw Error('Owned native path unavailable');
 const [emulator,configFile,entryFile,romFile]=paths.map(path=>realpathSync(path)) as [string,string,string,string];
 if([emulator,configFile,entryFile,romFile,dirname(entryFile)+'/peer.lua',dirname(entryFile)+'/utc-expiry.lua'].some(path=>!options.evidence.sourceFiles.some(file=>realpathSync(file.path)===realpathSync(path))))throw Error('Native launch pin missing');
 const config=JSON.parse(readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
 if(config.StartPaused!==true||config.AutoLoadLastSaveSlot!==false||config.AutoSaveLastSaveSlot!==false||config.Rewind?.Enabled!==false||config.PreferredCores?.SNES!=='Snes9x'||config.DontTryOtherCores!==true)throw Error('Native ordinary-save configuration unavailable');
 const evidence=new NativeGameEvidence(options.evidence);
 let host:Awaited<ReturnType<typeof listenForNativeBizHawk>>|undefined,transport:AuthenticatedGameTransport|undefined;
 let pauseConfirmed=false;
 let nativeStage='validated',nativeStartupFailure:string|null=null;
 const boundary:GameAdapterBoundaryOptions={providerRef:options.attach.providerRef,maxDurationMs:5000,sourceAvailable:evidence.sourceAvailable,acceptObservation:evidence.acceptObservation,acceptAction:evidence.acceptAction,reconcileEffect:evidence.reconcileEffect,admitRelease:evidence.admitRelease};
 const client=new WindowsGameHostClient({attach:options.attach,fetchAuthenticated:options.fetchAuthenticated,isScopeCurrent:options.isScopeCurrent,sourceIsQualified:attach=>evidence.installationAvailable(attach.scope,attach.pinsDigest),nativeBoundary:boundary,httpTimeoutMs:5000,sessionDurationMs:options.native.sessionDurationMs,shutdownTimeoutMs:5000,
  openNative:async(finalBoundary,context)=>{
   nativeStage='checkingSource';
   if(context.signal.aborted||!context.isCurrent(options.attach.scope))throw Error('Native launch fenced');
   const native={...options.native,scope:options.attach.scope,pinsDigest:options.attach.pinsDigest,boundary:finalBoundary,shutdownAdmission:evidence.admitRelease,onDisconnect:()=>client.close()};
   nativeStage='listening';host=await listenForNativeBizHawk(native);
   if(context.signal.aborted||!context.isCurrent(options.attach.scope)){await host.close();throw Error('Native launch fenced');}
   nativeStage='spawning';
   const child=spawn(emulator,['--config='+configFile,'--lua='+entryFile,romFile],{cwd:dirname(emulator),env:{...process.env,...nativeBridgeEnvironment(native),LIFESTREAM_BIZHAWK_EVIDENCE_FILE:evidence.evidenceFile},stdio:'ignore',windowsHide:false});
   evidence.bindOwnedProcess(child);child.once('error',()=>{nativeStartupFailure='spawnFailed';client.close();});child.once('exit',()=>{nativeStartupFailure??='childExited';client.close();});child.unref();
   try{
    nativeStage='pairing';
    transport=await host.connected;await transport.ready;
    // Native authentication is not proof that the GUI is actually watchable.
    nativeStage='graphicalProof';
    const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${child.pid}; [pscustomobject]@{pid=$p.Id;path=$p.Path;window=($p.MainWindowHandle -ne 0);session=$p.SessionId}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:2000,maxBuffer:4096});
    const gui=JSON.parse(stdout);if(gui.pid!==child.pid||realpathSync(gui.path)!==emulator||gui.window!==true||gui.session<1||!evidence.sourceAvailable(options.attach.scope,options.attach.pinsDigest))throw Error('Native graphical source unavailable');
    nativeStage='connected';return {adapter:transport.adapter,close:()=>{void host?.close();}};
   }catch(error){nativeStartupFailure??='connectionFailed';await host.close();throw error;}
  },
  shutdownExactOldLease:async context=>{
   const release=transport?.safetyRelease;
   if(release&&context.lastEnteredAction){
    const unavailable=async()=>{throw Error('Safety channel only');};
    pauseConfirmed=await evidence.shutdownExactOldLease(context.lastEnteredAction,{observe:unavailable,applyController:unavailable,controlSave:unavailable,releaseControls:release},3000);
   }
  }
 });
 const done=client.run();void done.catch(()=>{});
 return {fence:async()=>{client.close();await done.catch(()=>{});},done,ready:client.ready,evidence,get snapshot(){return Object.freeze({...client.snapshot,pauseConfirmed,nativeStage,nativeStartupFailure});}};
}
