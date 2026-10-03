'use strict';
const {gameHostBlockingReason,gameHostBlockingDetail}=require('./game-host-diagnostics.cjs');
/** Main-owned UI actions. Renderer IPC cannot start, select or assert an audience.
 * Fence before showing a failure modal, so cleanup never depends on gaining the
 * foreground from that modal. Log the closed reason before any dialog operation. */
function createGameHostMenuActions({window,gameHost,dialog,log=value=>console.log(JSON.stringify(value)),now=()=>new Date().toISOString(),setStartEnabled=()=>{}}){
 let starting=null,modal=null;
 const emit=(kind,value)=>log({kind,checkedAt:now(),...value});
 const show=async options=>{
  if(window.isDestroyed()||modal)return false;
  const pending=Promise.resolve().then(()=>dialog.showMessageBox(window,options));modal=pending;
  try{await pending;emit('gameHostDialogDismissed',{purpose:options.type==='warning'?'startFailure':'readiness'});return true;}
  catch{emit('gameHostDialogUnavailable',{blockingReason:'dialog_unavailable'});return false;}
  finally{if(modal===pending)modal=null;}
 };
 const report=async()=>{
  const value=gameHost?await gameHost.readiness():{ready:false,authenticated:false,blockingReason:'setup_required'};
  emit('onDemandDesktopGameHostReadiness',value);
  const detail=value.attached?'The approved native game host is attached.':value.blockingReason?gameHostBlockingDetail(value.blockingReason):'The current session and selected finite setup are ready. Start rechecks them before attaching the native game host.';
  await show({type:'info',title:'Game host connection',message:value.ready?'Native session is ready.':'Native session is not ready.',detail});return value;
 };
 const startApproved=()=>{
  if(starting)return starting;
  starting=(async()=>{
   try{const value=await gameHost.startApprovedSession();emit('gameHostStartAccepted',{nativeConnected:value.nativeConnected===true,attached:value.attached===true});return value;}
   catch(error){
    const blockingReason=gameHostBlockingReason(error);
    emit('gameHostStartRejected',{blockingReason,attachmentAccepted:false});setStartEnabled(false);
    // Even a pre-allocation failure consumes this one attempt. An existing modal
    // cannot strand an active driver or trigger an automatic retry.
    let stopCompleted=false;try{await gameHost.stop('startRejected');stopCompleted=true;}catch{/* Failure is recorded without exposing provider exceptions. */}
    emit('gameHostStartCleanup',{blockingReason,stopCompleted,enabled:gameHost.status().enabled===true});
    await show({type:'warning',title:'Game host connection',message:'The approved game session could not start.',detail:gameHostBlockingDetail(blockingReason)+' No automatic retry is performed.'});return null;
   }
  })().finally(()=>{starting=null;});return starting;
 };
 return Object.freeze({report,startApproved,stop:()=>gameHost?.stop('stop')});
}
module.exports={createGameHostMenuActions};
