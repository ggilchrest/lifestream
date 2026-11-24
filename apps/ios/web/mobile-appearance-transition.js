// Mobile switches keep one decoded model resident. Settings remain host-owned.
export async function prepareMobileAppearance(runtime,item,signal,prepare) {
 const check=()=>{signal?.throwIfAborted();if(runtime.disposed||runtime.contextLost)throw Error('Restart the display before changing appearance.');};
 check();if(runtime.preparingAppearance)throw Error('An appearance is already loading.');
 runtime.preparingAppearance=true;
 try {
  // Release textures, image bitmaps, adapter and blob URLs before fetching the
  // successor. Keeping both large models alive can terminate iOS WebContent.
  runtime.currentItem={id:'neutral'};runtime.commit(runtime.neutral());
  runtime.renderer.renderLists.dispose();runtime.renderer.render(runtime.scene,runtime.camera);
  // Give WebGL deletion and image cleanup a task boundary before decoding.
  await new Promise(resolve=>setTimeout(resolve,0));check();
  const candidate=await prepare(item,signal);
  try{check();return candidate;}catch(error){runtime.release(candidate);throw error;}
 } finally {runtime.preparingAppearance=false;}
}

export async function persistMobileAppearanceSelection(selections,assistant,item,save) {
 const previous=selections.get(assistant),next={id:item.id,digest:item.digest};selections.set(assistant,next);
 try{await save();}catch(error){if(selections.get(assistant)===next){if(previous===undefined)selections.delete(assistant);else selections.set(assistant,previous);}throw error;}
}

// The host awaits settings before this point. Recheck every retirement condition
// synchronously with commit; no await may separate this guard from scene mutation.
export function commitMobileAppearance(runtime,item,candidate,signal,current) {
 signal?.throwIfAborted();if(runtime.disposed||runtime.contextLost||!current())throw Error('The display or audience changed while saving.');
 runtime.currentItem=item;runtime.commit(candidate);
}
