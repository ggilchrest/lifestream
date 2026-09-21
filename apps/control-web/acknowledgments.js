import {AcknowledgmentPresentation} from './acknowledgment-presentation.js';
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const trackValid=(t,clip)=>t?.schemaVersion==='1.0.0'&&t.audioSha256===clip.audio.sha256&&t.durationMs===clip.audio.durationMs&&t.timeUnit==='ms'&&t.timeOrigin==='audio-start'&&t.cueSet===clip.visemes?.cueSet&&t.analysisRevision===clip.visemes?.analysisRevision&&Array.isArray(t.cues)&&t.cues.length>0&&t.cues.length<=600&&t.cues.every((c,i)=>Number.isFinite(c.startMs)&&Number.isFinite(c.endMs)&&c.startMs>=(i?t.cues[i-1].endMs:0)&&c.endMs>c.startMs&&c.endMs<=t.durationMs&&typeof c.cue==='string');

/** All network, integrity checks and decoding finish before a turn can select a
 * cue. Actual answer timing remains separate from these presentation events. */
export class AcknowledgmentCache {
 constructor({audio,current,manifest,artifact,mode=()=>({requiresSync:true}),preview=false,onMeasure=()=>{}}){Object.assign(this,{audio,current,fetchManifest:manifest,artifact,mode,preview,onMeasure});this.epoch=0;this.entries=new Map();this.seen=new Set();this.snapshot=null;this.playing=null;this.previous=null;}
 async refresh(){
  if(!this.current())return;const ticket=this.epoch;this.controller?.abort();const controller=this.controller=new AbortController();
  try{
   const m=await this.fetchManifest(controller.signal);if(ticket!==this.epoch||!this.current()||controller.signal.aborted)return;
   if(m.schemaVersion!=='1.0.0'||!Array.isArray(m.clips)||m.clips.length>5||typeof m.binding!=='string'||!Number.isInteger(m.revision))throw Error('Invalid acknowledgment manifest.');
   if(this.snapshot?.revision===m.revision&&this.snapshot?.binding===m.binding&&this.entries.size===m.clips.length)return;
   this.stop();this.entries.clear();this.snapshot=null;
   const entries=new Map();
   if(m.enabled||this.preview)for(const clip of m.clips){
    try{
     const a=clip.audio;if(a?.format!=='pcm_s16le'||a.sampleRateHz!==48000||a.channels!==1||!Number.isInteger(a.bytes)||a.bytes<2||a.bytes>288000||a.bytes%2||a.durationMs!==a.bytes/96)continue;
     const bytes=await this.artifact('audio',a.sha256,controller.signal);if(bytes.byteLength!==a.bytes||await sha(bytes)!==a.sha256)continue;
     const audio=this.audio();if(!audio||ticket!==this.epoch||!this.current()||controller.signal.aborted)return;const buffer=audio.createBuffer(1,a.bytes/2,48000),values=buffer.getChannelData(0),view=new DataView(bytes);for(let i=0;i<values.length;i++)values[i]=view.getInt16(i*2,true)/32768;
     let track=null;if(clip.synchronized&&clip.visemes){const data=await this.artifact('visemes',clip.visemes.sha256,controller.signal);if(data.byteLength<=100000&&data.byteLength===clip.visemes.bytes&&await sha(data)===clip.visemes.sha256){const candidate=JSON.parse(new TextDecoder().decode(data));if(trackValid(candidate,clip))track=candidate;}}
     entries.set(clip.id,{clip,buffer,track});
    }catch(error){if(error.name==='AbortError')return;/* One broken pair must not discard other usable clips. */}
   }
   if(ticket!==this.epoch||!this.current()||controller.signal.aborted)return;this.snapshot=m;this.entries=entries;
  }catch(error){if(ticket===this.epoch&&error.name!=='AbortError'){this.stop();this.snapshot=null;this.entries.clear();}}
 }
 play(trace,catalog,{responseReady=false,previewId=null,bufferOffset=0}={}){
  const audio=this.audio(),m=this.snapshot;if(!previewId&&this.seen.has(trace))return false;
  this.seen.add(trace);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value);
  if(responseReady||!this.current()||audio?.state!=='running'||!m||!m.enabled&&!(this.preview&&previewId)||m.binding!==catalog?.binding||m.revision!==catalog?.revision||!Number.isFinite(bufferOffset)||bufferOffset<0||bufferOffset>.5)return false;
  const mode=this.mode();let entries=[...this.entries.values()].filter(e=>catalog.clipIds.includes(e.clip.id)&&(!previewId||e.clip.id===previewId)&&(!mode.requiresSync||e.track&&mode.accepts?.(e.track)===true));
  if(!entries.length)return false;if(entries.length>1)entries=entries.filter(e=>e.clip.id!==this.previous);
  const entry=entries[Math.floor(Math.random()*entries.length)];this.stop();const source=audio.createBufferSource(),start=audio.currentTime+bufferOffset,segmentId=crypto.randomUUID(),play={trace,segmentId,entry,source,start,end:start+entry.buffer.duration};source.buffer=entry.buffer;source.connect(audio.destination);this.playing=play;this.previous=entry.clip.id;
  source.onended=()=>{source.disconnect();if(this.playing===play){this.playing=null;this.onMeasure({kind:'acknowledgment-ended',trace,segmentId,audioTime:audio.currentTime});}};
  source.start(start);this.onMeasure({kind:'acknowledgment-start',trace,segmentId,clipId:entry.clip.id,audioTime:start,observedAt:performance.now()});return true;
 }
 sample(){const p=this.playing,a=this.audio();if(!p||!a||a.state!=='running'||!this.current()||a.currentTime<p.start||a.currentTime>=p.end)return {playing:false,amplitude:0};const offset=(a.currentTime-p.start)*1000,sample=Math.floor(offset*48),values=p.entry.buffer.getChannelData(0);let energy=0;for(let i=sample;i<Math.min(sample+480,values.length);i++)energy+=values[i]**2;return {playing:true,amplitude:Math.sqrt(energy/Math.max(1,Math.min(480,values.length-sample))),trace:p.trace,segmentId:p.segmentId,sampleOffset:sample,clock:'AudioContext.currentTime',acknowledgment:true,viseme:p.entry.track?.cues.find(c=>c.startMs<=offset&&offset<c.endMs)?.cue??null,cueSet:p.entry.track?.cueSet??null};}
 stop(){const p=this.playing;this.playing=null;if(p){p.source.onended=null;try{p.source.stop();}catch{}p.source.disconnect();}}
 clear(){this.epoch++;this.controller?.abort();this.controller=null;this.stop();this.entries.clear();this.snapshot=null;this.seen.clear();this.previous=null;}
}

export function installAcknowledgmentAdministration({anchor,api,context}){
 const section=document.createElement('section');section.className='acknowledgment-admin';section.innerHTML='<h4>Spoken acknowledgments</h4><p>Short cached cues can acknowledge an accepted spoken turn while its answer is prepared. They never confirm that an action succeeded.</p><form><label><input name="enabled" type="checkbox"> Enable acknowledgment catalog for this Assistant</label><label>Default lifetime in days<input name="days" type="number" min="1" max="365" step="1" value="5" required></label><div class="actions"><button type="submit">Save acknowledgment settings</button><button type="button" data-refresh class="secondary">Refresh acknowledgments</button><button type="button" data-stop class="secondary" disabled>Stop acknowledgment preview</button></div></form><p role="status">Select an Assistant and refresh.</p><div data-clips></div>';
 anchor.append(section);const form=section.querySelector('form'),status=section.querySelector('[role=status]'),list=section.querySelector('[data-clips]'),stop=section.querySelector('[data-stop]');let epoch=0,snapshot=null,audio=null,previewEpoch=0,synchronized=false;
 const scope=()=>{const id=context()?.assistantId;if(!window.lifestreamAuth?.session||!id)throw Error('Sign in and select an Assistant.');return id;},path=()=>`/api/admin/v1/assistants/${scope()}/acknowledgments`;
 const cache=new AcknowledgmentCache({audio:()=>audio,current:()=>!!window.lifestreamAuth?.session&&!!snapshot&&location.hash==='#voice'&&!document.hidden,mode:()=>({requiresSync:synchronized,accepts:track=>presentation.accepts(track)}),preview:true,manifest:()=>api(path()),artifact:async(kind,id,signal)=>{const response=await fetch(path()+`/${kind}/${id}`,{credentials:'same-origin',signal});if(!response.ok)throw Error('Preview unavailable.');return response.arrayBuffer();},onMeasure:event=>{if(event.kind==='acknowledgment-ended'){stop.disabled=true;presentation.cancel();status.textContent=synchronized?'Paired acknowledgment preview finished.':'Audio-only acknowledgment preview finished.';}}});
 const presentation=new AcknowledgmentPresentation({anchor:section,api,context,playback:()=>cache.sample(),onFailure:message=>{stopPreview();status.textContent=message;}});list.before(presentation.stage);
 const stopPreview=()=>{previewEpoch++;cache.stop();presentation.cancel();stop.disabled=true;};
 const play=async(clip,audioOnly=false)=>{
  window.dispatchEvent(new CustomEvent('lifestream-preview-start',{detail:'acknowledgment'}));stopPreview();const ticket=previewEpoch,scopeTicket=epoch;stop.disabled=false;status.textContent='Preparing acknowledgment preview…';
  try{
   audio??=new AudioContext();await audio.resume();if(ticket!==previewEpoch||scopeTicket!==epoch)return;
   if(audioOnly){presentation.dispose();synchronized=false;}else synchronized=await presentation.prepare();
   if(ticket!==previewEpoch||scopeTicket!==epoch)return;await cache.refresh();if(ticket!==previewEpoch||scopeTicket!==epoch)return;
   const m=cache.snapshot;if(!m)throw Error('Preview is unavailable.');
   if(!cache.play(crypto.randomUUID(),{revision:m.revision,binding:m.binding,clipIds:[clip.id]},{previewId:clip.id}))throw Error(synchronized?'A compatible audio and mouth-cue pair is unavailable. Refresh, or choose Preview audio only.':'This clip is unavailable. Refresh acknowledgments before previewing.');
   status.textContent=synchronized?'Playing paired acknowledgment preview with the selected appearance.':'Playing audio-only acknowledgment preview.';
  }catch(error){if(ticket!==previewEpoch||scopeTicket!==epoch)return;stopPreview();if(error.name!=='AbortError')status.textContent=error.message;}
 };
 const perform=work=>()=>void work().catch(error=>{status.textContent=error.message;});
 const refresh=async()=>{const ticket=epoch,value=await api(path());if(ticket!==epoch)return;snapshot=value;form.elements.enabled.checked=value.enabled;form.elements.days.value=value.defaultTtlDays;status.textContent=`${value.readyCount}/5 audio clips · ${value.synchronizedReadyCount}/5 with synchronized mouth animation · ${{publishedCurrentRevision:'Ready',notRun:'Not prepared',foregroundOrCapacity:'Waiting for foreground work',foregroundPreempted:'Paused for foreground work',providerPriorityUnverified:'Provider priority is not verified',workFailed:'Preparation failed; usable clips retained','not-run':'Not prepared'}[value.maintenance]??'Waiting for preparation'}. Expiry schedules gradual replacement; it does not immediately silence the catalog.`;list.replaceChildren();
  for(const clip of value.clips){const row=document.createElement('article');row.className='saved-voice-candidate';row.setAttribute('aria-label',clip.text);const text=document.createElement('p');text.textContent=clip.text+' · '+(clip.expiresAt?new Date(clip.expiresAt).toLocaleString():'Kept indefinitely');const actions=document.createElement('div');actions.className='actions';const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=label;b.onclick=perform(fn);actions.append(b);return b;};
   button('Preview acknowledgment',()=>play(clip));button('Preview audio only',()=>play(clip,true));
   const edit=expiresAt=>async()=>{stopPreview();cache.clear();await api(path(),{method:'POST',body:JSON.stringify({operation:'edit',expectedRevision:snapshot.revision,id:clip.id,clipRevision:clip.revision,expiresAt})});await refresh();window.dispatchEvent(new Event('lifestream-acknowledgments'));};
   button('Extend by default lifetime',edit(new Date(Math.max(Date.now(),Date.parse(clip.expiresAt??'')||0)+value.defaultTtlDays*86400000).toISOString()));button('Keep indefinitely',edit(null));button('Restore finite expiry',edit(new Date(Date.now()+value.defaultTtlDays*86400000).toISOString()));button('Remove acknowledgment',edit('remove'));row.append(text,actions);list.append(row);
  }
 };
 form.onsubmit=event=>{event.preventDefault();perform(async()=>{stopPreview();cache.clear();const enabled=form.elements.enabled.checked,defaultTtlDays=Number(form.elements.days.value);if(!snapshot)await refresh();await api(path(),{method:'POST',body:JSON.stringify({operation:'configure',expectedRevision:snapshot.revision,enabled,defaultTtlDays})});await refresh();window.dispatchEvent(new Event('lifestream-acknowledgments'));})();};section.querySelector('[data-refresh]').onclick=perform(async()=>{stopPreview();await refresh();});stop.onclick=()=>{stopPreview();status.textContent='Acknowledgment preview stopped.';};
 window.addEventListener('lifestream-preview-start',event=>{if(event.detail!=='acknowledgment')stopPreview();});
 const clear=()=>{epoch++;stopPreview();snapshot=null;cache.clear();presentation.dispose();list.replaceChildren();form.reset();status.textContent='Select an Assistant and refresh.';};for(const event of ['lifestream-auth','lifestream-assistant','lifestream-relationship','lifestream-session-context','lifestream-audience'])window.addEventListener(event,clear);window.addEventListener('hashchange',()=>{if(location.hash!=='#voice'){stopPreview();presentation.dispose();}});document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPreview();presentation.dispose();}});window.addEventListener('pagehide',()=>{clear();void audio?.close();});return {refresh:perform(refresh),clear};
}
