/** A read-only preview of the endpoint's effective appearance. It reuses the
 * conversation renderer and paired playback clock without saving a selection. */
export class AcknowledgmentPresentation {
 constructor({anchor,api,context,playback,onFailure=()=>{}}){
  Object.assign(this,{api,context,playback,onFailure});this.epoch=0;
  this.stage=document.createElement('div');this.stage.className='acknowledgment-preview';this.stage.hidden=true;
  this.stage.innerHTML='<canvas aria-label="Acknowledgment appearance preview"></canvas><span class="acknowledgment-preview-state">Preview</span>';anchor.append(this.stage);
 }
 active(){return location.hash==='#voice'&&!document.hidden&&!!window.lifestreamAuth?.session;}
 cancel(){this.epoch++;this.pending?.abort();this.pending=null;this.runtime?.current?.speechMotion?.reset();this.runtime?.applyState('idle');}
 dispose(){this.cancel();this.runtime?.dispose();this.runtime=null;this.key=null;this.stage.hidden=true;}
 accepts(track){return this.active()&&this.runtime?.disposed===false&&!this.runtime.renderer.getContext().isContextLost()&&this.runtime.current?.speechMotion?.accepts(track)===true;}
 async prepare(){
  this.cancel();const ticket=this.epoch,controller=this.pending=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let prepared,renderer;
  const current=()=>{controller.signal.throwIfAborted();if(ticket!==this.epoch||!this.active())throw new DOMException('Preview cancelled.','AbortError');};
  try{
   current();const value=await this.api('/api/runtime/v1/presentation',{signal:controller.signal});current();
   const selected=value.selection?.override??value.selection?.default;
   if(!selected){this.runtime?.dispose();this.runtime=null;this.key=null;this.stage.hidden=true;return false;}
   const item=[value.neutral,...value.packages].find(x=>x.id===selected.id&&x.digest===selected.digest);
   if(!item?.manifest?.speech)throw Error('The selected appearance has no compatible timed mouth mapping. Choose Preview audio only, or apply a compatible appearance in Conversation.');
   if(document.documentElement.dataset.audienceProtected==='true')throw Error('Private appearance preview requires a current private audience.');
   const key=JSON.stringify([this.context()?.assistantId,value.endpointId,item.id,item.digest]);
   if(this.key===key&&this.runtime?.disposed===false&&!this.runtime.renderer.getContext().isContextLost())return true;
   const {PresentationRuntime}=await import('./presentation-runtime.js');current();
   this.runtime?.dispose();this.runtime=null;this.key=null;
   // A fresh canvas also recovers from a previous graphics-context loss.
   const old=this.stage.querySelector('canvas'),canvas=old.cloneNode(false);old.replaceWith(canvas);this.stage.hidden=false;
   renderer=this.runtime=new PresentationRuntime(canvas,{playback:this.playback,identity:()=>({assistantId:this.context()?.assistantId,endpointId:value.endpointId}),onFailure:message=>{this.dispose();this.onFailure(message);}});
   prepared=await renderer.prepare(item,controller.signal);current();renderer.commit(prepared);prepared=null;this.key=key;return true;
  }catch(error){if(ticket===this.epoch)this.dispose();throw error;}
  finally{if(prepared)renderer?.release(prepared);clearTimeout(timer);if(this.pending===controller)this.pending=null;}
 }
}
