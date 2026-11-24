// Select from the independently required inventory; testing order cannot disable a required check.
export function releaseAppearancePlan(catalog){
 const items=[catalog.neutral,...catalog.packages],ids=items.map(x=>x?.id);
 if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw Error('Required appearance identities must be unique.');
 const contextLossAdapterId=catalog.packages.filter(x=>x.manifest?.schemaVersion==='1.5.0').map(x=>x.id).sort()[0]??null;
 const transitionPairs=[];for(let a=0;a<catalog.packages.length;a++)for(let b=a+1;b<catalog.packages.length;b++){const from=catalog.packages[a].id,to=catalog.packages[b].id;transitionPairs.push({from,to},{from:to,to:from});}
 return {transitionPairs,contextLossAdapterId,appearanceIds:[...ids.filter(id=>id!==contextLossAdapterId),...(contextLossAdapterId?[contextLossAdapterId]:[])]};
}
export function contextLossResultAccepted(requiredAdapterId,result){
 return requiredAdapterId===null?result?.status==='notApplicable':result?.status==='passed'&&result?.id===requiredAdapterId;
}
// Offline release check. Uses the same mobile runtime and bundled-resource loader as the app.
export function installAssetProbe({MobilePresentationRuntime,bundledAppearances,bundledResource}) {
 const failures=[];
 const runtime=new MobilePresentationRuntime(document.querySelector('canvas'),{
  retrieveResource:bundledResource,randomAnimations:true,onFailure:message=>failures.push(message)
 });
 const finite=root=>{root.updateMatrixWorld(true);root.traverse(node=>{
  if(!node.matrixWorld.elements.every(Number.isFinite))throw Error('Non-finite animation transform.');
 });};
 const render=()=>{finite(runtime.current.root);runtime.renderer.render(runtime.scene,runtime.camera);
  if(runtime.renderer.getContext().getError()!==0)throw Error('WebGL rendering failed.');
  if(failures.length)throw Error(failures.join('; '));
 };
 globalThis.checkAppearance=async (id,exerciseAnimations=true)=>{
  const catalog=await bundledAppearances(),item=[catalog.neutral,...catalog.packages].find(x=>x.id===id);
  if(!item)throw Error('Expected appearance is absent.');
  runtime.currentItem=item;
  const value=await runtime.prepare(item,AbortSignal.timeout(60000));
  runtime.commit(value);render();
  let meshes=0;value.root.traverse(node=>{if(node.isMesh)meshes++;});
  if(!meshes)throw Error('The prepared appearance has no renderable meshes.');
  const tested=[];
  if(exerciseAnimations&&item.manifest?.schemaVersion==='1.5.0'){
   if(!value.adapter)throw Error('External-animation appearance has no runtime adapter.');
   for(const clip of item.manifest.worldDelta.animations){
    if(!runtime.motionAction('clip',clip.sourceAnimationId))throw Error('Declared adapter animation refused.');
    for(let n=0;n<3;n++){value.adapter.update(.1,{motionEnabled:true});render();}
    if(value.adapter.state.clipId!==clip.sourceAnimationId)throw Error('Wrong adapter animation selected.');
    tested.push(clip.clipName);
   }
   runtime.motionAction('cycle');
   runtime.setPhysicsSettings({hair:true,soft:true,collision:true,hairIntensity:1,softIntensity:1,collisionIntensity:1});
  }else if(exerciseAnimations&&item.manifest){
   value.playlist?.dispose();delete value.playlist;
   for(const name of new Set([...Object.values(item.manifest.animations??{}),...(item.manifest.animationLibrary??[]).map(x=>x.clip)])){
    const action=value.actions?.get(name);if(!action)throw Error('Declared embedded animation is unavailable.');
    value.mixer.stopAllAction();action.reset().play();
    for(let n=0;n<3;n++){value.mixer.update(.1);render();}
    tested.push(name);
   }
   value.mixer?.stopAllAction();value.actions?.get(item.manifest.animations?.idle)?.reset().play();
  }
  runtime.applyState('idle');runtime.frame(value);render();
  const gl=runtime.renderer.getContext(),pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
  gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  let visiblePixels=0;for(let n=0;n<pixels.length;n+=4)if(Math.abs(pixels[n]-pixels[0])+Math.abs(pixels[n+1]-pixels[1])+Math.abs(pixels[n+2]-pixels[2])>12)visiblePixels++;
  if(visiblePixels<100)throw Error('The rendered appearance is blank.');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return {id,schema:item.manifest?.schemaVersion??'neutral',meshes,visiblePixels,declaredAnimationsTested:tested,adapter:!!value.adapter};
 };
 // Direct user transitions: no harness unload between the two Apply actions.
 globalThis.checkAppearanceTransition=async({from,to})=>{
  if(runtime.current.id!==from)await globalThis.checkAppearance(from,false);const previous=runtime.current,retrieve=runtime.retrieveResource;let checked=false;
  runtime.retrieveResource=(...args)=>{
   if(!checked){checked=true;if(!previous.released||runtime.current===previous||runtime.currentItem.id!=='neutral')throw Error('Previous appearance remains resident when successor retrieval starts.');}
   return retrieve(...args);
  };
  try{const result=await globalThis.checkAppearance(to,false);if(!checked||runtime.current.id!==to||!previous.released)throw Error('Direct appearance transition was not verified.');return {from,to,status:'passed',previousReleasedBeforeRetrieval:true,visiblePixels:result.visiblePixels,currentId:runtime.current.id};}
  finally{runtime.retrieveResource=retrieve;}
 };
 // Focused failure-lifecycle check after successful real adapter preparation.
 globalThis.checkContextLoss=()=>{
  const value=runtime.current,original=value.adapter;if(!original)return {status:'notApplicable'};
  const calls={};value.adapter=new Proxy({},{get(_target,key){const member=Reflect.get(original,key);if(typeof member!=='function')return member;return(...args)=>{calls[key]=(calls[key]??0)+1;return member.apply(original,args);};}});
  runtime.adapterPreview=true;
  const event=new Event('webglcontextlost',{cancelable:true});document.querySelector('canvas').dispatchEvent(event);
  if(!runtime.contextLost||!event.defaultPrevented)throw Error('Context loss was not latched.');
  if(runtime.motionAction('cycle')!==false||runtime.setPhysicsSettings({hair:true})!==false)throw Error('Adapter controls survived context loss.');
  let refused=false;try{runtime.preview('idle');}catch{refused=true;}if(!refused)throw Error('Preview survived context loss.');
  runtime.dispose();runtime.dispose();
  if(calls.playCycle||calls.playClip||calls.setSettings||calls.dispose!==1||!(calls.suspend>=1))throw Error('Context loss/disposal restarted motion or released the adapter incorrectly.');
  return {status:'passed',controlsRefused:true,adapterCalls:calls,repeatedDispose:true};
 };
 globalThis.releaseAppearance=()=>{runtime.currentItem={id:'neutral'};runtime.commit(runtime.neutral());globalThis.gc?.();};
 globalThis.assetProbeReady=true;
}
