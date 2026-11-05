import {captureFrameApproval,nativeSourceException,type FrameApprovalCapture} from './native-source-witness.ts';
import {LiveFrameDecoder,gameFramePixels} from './live-frame-decoder.ts';
import {readNativeFile,scopeDigest,fileDigest} from './c72-native-configuration.ts';
import {isDeepStrictEqual} from 'node:util';
import {writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** An actual trusted operator review of an owned native PNG (authorship is retained separately).
 * Initial decoder may expose pixels but supplies no ordinary-gameplay claim.
 * Only this exact run/current PNG can seed the finite reviewed manifest. */
export function createReviewedLiveFrame(options:any){
 const explicitRetention=Object.hasOwn(options,'maximumRetentionMs'),maximumRetentionMs=explicitRetention?options.maximumRetentionMs:120000;
 if(!Number.isSafeInteger(maximumRetentionMs)||maximumRetentionMs<1||maximumRetentionMs>300000)throw Error('Finite reviewed frame retention required');
 let pendingCapturedAt:number|undefined,approvalRevision=0;
 const scene=options.reviewedScene,dialogue=options.reviewedDialogue;
 if(scene&&dialogue)throw Error('Separate scene and dialogue profiles required');
 const scope=structuredClone(options.scope),pins=options.pinsDigest,empty=new LiveFrameDecoder(options.initialManifest);let pending:any;
 const selected=()=>{try{const value=JSON.parse(readNativeFile(options.file,32768,true).toString('utf8')),until=Date.parse(value.expiresAt);if(value.schemaVersion!=='ct-native-frame-review/1'||value.scopeDigest!==scopeDigest(scope)||value.pinsDigest!==pins||!Number.isFinite(until)||until<=Date.now()||until>Date.now()+maximumRetentionMs)throw Error();if(scene){if(value.sceneManifestDigest!==scene.decoder.manifestDigest)throw Error();return scene.decoder;}return new LiveFrameDecoder(value.manifest);}catch{return empty;}};
 const decoder={capture:selected,get revision(){return selected().revision;},get manifestDigest(){return selected().manifestDigest;},decode:(input:any)=>selected().decode(input)};
 const review=(frame:any)=>{
  if(!frame||!isDeepStrictEqual(frame.observation.scope,scope)||frame.observation.screenshots.length!==1||!isDeepStrictEqual(frame.observation.screenshots[0],frame.screenshot)||fileDigest(frame.bytes)!==frame.screenshot.sha256||frame.bytes.length!==frame.screenshot.byteLength)throw Error('Current owned native frame required');
  const shot=frame.screenshot;const value={...(scene?{sceneProfile:scene.descriptor}:{}),requestId:randomUUID(),scopeDigest:scopeDigest(scope),pinsDigest:pins,pngSha256:shot.sha256,frameNumber:shot.frameNumber,width:shot.width,height:shot.height,expiresAt:shot.expiresAt};
  pending={...value,confirmationDigest:hash(value)};if(explicitRetention)pendingCapturedAt=Date.parse(shot.capturedAt);
  return {...pending,mediaType:'image/png',pngBase64:frame.bytes.toString('base64'),meaning:scene?'Review this current game image and the listed independently reviewed scene states. Only exact recognized states remain eligible; other images stop input. No controller permission is supplied.':'Review actual visible game pixels. Confirm ordinary gameplay/story dialogue only if no save/load/reset or other protected menu is shown.'};
 };
 const approve=(body:any,frame:any,capture?:FrameApprovalCapture)=>{
  let stage='approval-identity',predicate='identity_threw',published=false,reported=false;
  const report=(error?:unknown)=>{if(!capture||reported)return;reported=true;captureFrameApproval(capture,{stage,predicate,approvalPublished:published,...(error===undefined?{}:{exceptionClass:nativeSourceException(error)})});};
  const bad=(value:boolean,name:string)=>{if(value){predicate=name;report();return true;}return false;};
  try{
   if(bad(!pending,'pending_absent')||bad(!body,'body_absent')||bad(Object.keys(body).sort().join(',')!=='confirmationDigest,noProtectedMenus,ordinaryGameplay,requestId','body_keys')||bad(body.requestId!==pending.requestId,'request_identity')||bad(body.confirmationDigest!==pending.confirmationDigest,'confirmation_digest')||bad(body.ordinaryGameplay!==true,'ordinary_gameplay_confirmation')||bad(body.noProtectedMenus!==true,'protected_menu_confirmation')||bad(Date.parse(pending.expiresAt)<=Date.now(),'pending_expired')||bad(!frame,'frame_absent')||bad(!isDeepStrictEqual(frame.observation.scope,scope),'scope_identity')||bad(frame.screenshot.sha256!==pending.pngSha256,'png_identity')||bad(frame.screenshot.frameNumber!==pending.frameNumber,'frame_number')||bad(fileDigest(frame.bytes)!==pending.pngSha256,'png_bytes_digest')||bad(!isDeepStrictEqual(frame.observation.screenshots[0],frame.screenshot),'screenshot_identity'))throw Error('Exact current native frame review required');
   stage='approval-pixels';predicate='pixel_decode_threw';const image=gameFramePixels(frame.bytes);try{
    if(bad(image.width!==pending.width||image.height!==pending.height,'dimensions_changed')||bad(image.rgb.every(v=>v===0),'black_frame'))throw Error('Black frame or changed dimensions cannot qualify gameplay');
    predicate='scene_decode_threw';if(scene&&bad(!scene.decoder.decode({scope,observation:frame.observation,bytes:frame.bytes,now:Date.now()}).some((field:any)=>field.fieldId==='ct.ui.controller-domain'&&field.value==='ordinaryGameplay'),'scene_not_ordinary'))throw Error('Current frame is not in the reviewed scene profile');
    stage='approval-retention';predicate='authority_read_threw';const now=Date.now(),authorityExpires=options.expiresAt();
    const until=explicitRetention?Math.min(Date.parse(pending.expiresAt),pendingCapturedAt!+maximumRetentionMs,authorityExpires):Math.min(now+maximumRetentionMs,authorityExpires);
    if(bad(!Number.isFinite(until),'retention_not_finite')||bad(until<=now,'retention_expired')||explicitRetention&&(bad(!Number.isFinite(pendingCapturedAt),'captured_time_not_finite')||bad(pendingCapturedAt!>now,'captured_time_future')))throw Error('Current original frame retention required');
    stage='approval-publication';predicate='manifest_build_threw';const expiresAt=new Date(until).toISOString();
    const regions=[{x:0,y:0,width:image.width,height:image.height,rgbSha256:fileDigest(image.rgb)}];
    const cues:Array<{fieldId:string;value:string|boolean;regions:typeof regions}>=[{fieldId:'ct.ui.controller-domain',value:'ordinaryGameplay',regions}];
    // Only this same approved PNG can seed the optional literal boolean cue.
    // Unknown images supply no dialogue field, including no inferred false.
    if(dialogue){
     const fields=dialogue.decoder.decode({scope,observation:frame.observation,bytes:frame.bytes,now:Date.now()});
     const field=fields.find((value:any)=>value.fieldId==='ct.ui.dialogue.present');
     if(field){if(typeof field.value!=='boolean')throw Error('Boolean reviewed dialogue required');cues.push({fieldId:field.fieldId,value:field.value,regions});}
    }
    const manifest={revision:'1.0.0',cues};
    const value={...(scene?{sceneManifestDigest:scene.decoder.manifestDigest}:{}),schemaVersion:'ct-native-frame-review/1',scopeDigest:scopeDigest(scope),pinsDigest:pins,pngSha256:pending.pngSha256,expiresAt,manifest};const next=options.file+'.next';let created=false;
    try{predicate='exclusive_write_threw';writeFileSync(next,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});created=true;predicate='rename_threw';renameSync(next,options.file);published=true;created=false;}catch(error){report(error);throw error;}finally{if(created){predicate='temporary_cleanup_threw';unlinkSync(next);}}
    pending=undefined;++approvalRevision;predicate='return_manifest_threw';return {qualified:true,expiresAt,manifestDigest:scene?.decoder.manifestDigest??new LiveFrameDecoder(manifest).manifestDigest};
   }finally{image.rgb.fill(0);}
  }catch(error){report(error);throw error;}
 };

 const current=(observation?:any)=>{try{const selectedDecoder=selected();if(selectedDecoder.manifestDigest===empty.manifestDigest)return false;return !observation||observation.visibleState?.some((v:any)=>v.fieldId==='ct.ui.controller-domain'&&v.value==='ordinaryGameplay'&&v.manifestDigest===selectedDecoder.manifestDigest&&v.lastObservedRef===observation.observationId&&Date.parse(v.freshUntil)>Date.now());}catch{return false;}};
 return Object.freeze({decoder,review,approve,current,approvalRevision:()=>approvalRevision,stopOnUnknown:!!scene});
}

export async function observeUntilFrameReviewed({observe,current,frameOwner,signal,maximumRunMs,onWaiting,preparation,qualifyForPlay}:any){
 if(preparation!==undefined&&preparation!=='untilCancelled')throw Error('Original preparation lifetime required');
 const deadline=preparation==='untilCancelled'?null:performance.now()+maximumRunMs;
 try{while(!signal.aborted&&current()&&(deadline===null||performance.now()<deadline)){
  const approvalRevision=frameOwner?.approvalRevision?.();
  const observation=await observe();if(!observation)return null;if(!frameOwner||frameOwner.current(observation))return observation;
  if(qualifyForPlay){
   await qualifyForPlay(observation);
   // Explicit Play just qualified this exact owned image. Return it after
   // rechecking the original context; another capture would chase a moving
   // framebuffer forever when game time runs normally.
   if(!signal.aborted&&current()&&frameOwner.current(observation))return observation;
   continue;
  }
  // A native observation already in flight may have used the decoder from
  // before the actual image approval. Read again with the approved decoder;
  // that stale result must not reopen the just-completed review.
  if(approvalRevision!==undefined&&frameOwner.approvalRevision()!==approvalRevision)continue;
  if(frameOwner.stopOnUnknown===true&&frameOwner.current())return null;
  onWaiting(true);await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,1000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
 }return null;}finally{onWaiting(false);}
}

/** Explicit Play authorizes this owned SNES framebuffer/controller domain.
 * This is host target/custody evidence, never a fabricated human image review
 * or a model-authored permission. It cannot qualify another run or desktop. */
export function createOwnedPlayFrameQualification(options:any){
 const scope=structuredClone(options.scope),pins=options.pinsDigest,maximumRetentionMs=options.maximumRetentionMs;
 if(typeof options.current!=='function'||!Number.isSafeInteger(maximumRetentionMs)||maximumRetentionMs<1||maximumRetentionMs>300000)throw Error('Bounded current Play authority required');
 const empty=new LiveFrameDecoder({revision:'1.0.0',cues:[]},options.ordinaryGameTime?{ordinaryGameTime:true}:undefined);let selected=empty,until=0,revision=0,lastShot:any=null;
 const active=()=>{try{return options.current()===true&&Date.now()<until;}catch{return false;}};
 const decoder={capture:()=>active()?selected:empty,get revision(){return (active()?selected:empty).revision;},get manifestDigest(){return (active()?selected:empty).manifestDigest;},decode:(input:any)=>(active()?selected:empty).decode(input)};
 const current=(observation?:any)=>active()&&!!lastShot&&(!observation||isDeepStrictEqual(observation.scope,scope)&&observation.pinsDigest===pins&&observation.screenshots?.length===1&&observation.screenshots[0].sha256===lastShot.sha256&&observation.frameNumber===lastShot.frameNumber&&Date.parse(observation.capturedAt)>=Date.parse(lastShot.capturedAt)&&Date.parse(observation.capturedAt)<=Date.now());
 const qualifyOwnedFrame=(frame:any)=>{
  if(options.current()!==true||!frame||!isDeepStrictEqual(frame.observation.scope,scope)||frame.observation.pinsDigest!==pins||frame.observation.frameNumber!==frame.screenshot?.frameNumber||frame.observation.capturedAt!==frame.screenshot?.capturedAt||frame.observation.screenshots.length!==1||!isDeepStrictEqual(frame.observation.screenshots[0],frame.screenshot)||fileDigest(frame.bytes)!==frame.screenshot.sha256||frame.bytes.length!==frame.screenshot.byteLength)throw Error('Current owned game framebuffer required');
  const now=Date.now(),captured=Date.parse(frame.screenshot.capturedAt),expiry=Math.min(Date.parse(frame.screenshot.expiresAt),captured+maximumRetentionMs,options.expiresAt());
  if(!Number.isFinite(captured)||captured>now||!Number.isFinite(expiry)||expiry<=now)throw Error('Fresh bounded game framebuffer required');
  const image=gameFramePixels(frame.bytes);
  try{
   if(image.width!==frame.screenshot.width||image.height!==frame.screenshot.height||!options.ordinaryGameTime&&image.rgb.every(value=>value===0))throw Error('Visible owned game pixels required');
   const regions=[{x:0,y:0,width:image.width,height:image.height,rgbSha256:fileDigest(image.rgb)}],cues:any[]=[]; // Target authorization is not a visual scene classification.
   if(options.reviewedDialogue){const fields=options.reviewedDialogue.decoder.decode({scope,observation:frame.observation,bytes:frame.bytes,now});const field=fields.find((value:any)=>value.fieldId==='ct.ui.dialogue.present');if(field&&typeof field.value==='boolean')cues.push({fieldId:field.fieldId,value:field.value,regions});}
   const next=new LiveFrameDecoder({revision:'1.0.0',cues},options.ordinaryGameTime?{ordinaryGameTime:true}:undefined);if(options.current()!==true)throw Error('Play authority changed');selected=next;lastShot=structuredClone(frame.screenshot);until=expiry;revision++;
   return Object.freeze({qualificationOrigin:'explicitPlayOwnedGame',scopeDigest:scopeDigest(scope),pngSha256:frame.screenshot.sha256,expiresAt:new Date(until).toISOString(),humanReviewed:false});
  }finally{image.rgb.fill(0);}
 };
 return Object.freeze({decoder,current,qualifyOwnedFrame,approvalRevision:()=>revision,stopOnUnknown:false});
}
