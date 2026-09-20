// Presentation is optional. A package or GPU failure never disables conversation controls.
export function installPresentation({anchor,api,busy,playback,identity}) {
 const section=document.createElement('section');section.className='presentation-panel';section.setAttribute('aria-label','Assistant appearance');
 section.innerHTML='<div class="presentation-stage"><canvas aria-label="Assistant presentation"></canvas><span class="presentation-state">Idle</span></div><div class="presentation-controls"><label>Appearance<select aria-label="Appearance"><option value="neutral">Neutral reference</option></select></label><label>Apply to<select aria-label="Appearance scope"><option value="default">This endpoint</option><option value="session">This session only</option></select></label><div class="actions"><button type="button" data-apply>Apply appearance</button><button type="button" class="secondary" data-refresh>Refresh appearances</button><button type="button" class="secondary" data-restart>Restart display</button><button type="button" class="secondary" data-inherit disabled>Use endpoint default</button></div><p role="status" class="muted">Neutral reference · appearance does not change identity or voice.</p><p class="muted" data-selection-status></p><details class="presentation-preview"><summary>Preview animations</summary><p class="muted">Preview the applied appearance for five seconds. No speech is generated and no settings are saved.</p><label>Animation state<select aria-label="Animation preview state"><option value="idle">Idle</option><option value="listening">Listening</option><option value="preparing">Preparing</option><option value="speaking">Speaking motion only</option><option value="interrupted">Interrupted</option><option value="working">Working</option><option value="waiting">Waiting</option><option value="failure">Failure</option></select></label><div class="actions"><button type="button" class="secondary" data-preview>Preview animation</button><button type="button" class="secondary" data-end-preview>End preview</button></div><p role="status" data-preview-status>No preview running. Phoneme alignment is not provided.</p><label>Face motion<select aria-label="Face preview motion"><option value="blink">Blink</option><option value="left">Look left</option><option value="right">Look right</option><option value="up">Look up</option><option value="down">Look down</option><option value="center">Look forward</option></select></label><button type="button" class="secondary" data-face-preview>Preview face motion</button><p class="muted">Uses declared blink/gaze mappings. End preview stops either preview. Ambient motion respects reduced-motion preferences; no camera or gaze sensing is used.</p></details></div>';
 anchor.querySelector('.room-layout').prepend(section);
 const select=section.querySelector('[aria-label="Appearance"]'),scope=section.querySelector('[aria-label="Appearance scope"]'),status=section.querySelector('[role="status"]'),button=section.querySelector('[data-apply]');
 const previewStatus=section.querySelector('[data-preview-status]'),inherit=section.querySelector('[data-inherit]'),selectionStatus=section.querySelector('[data-selection-status]');
 const describe=mapping=>mapping.degraded?(mapping.effective==='idle'?'uses the idle animation fallback':'has no mapped animation'):'uses its declared animation';
 let runtime,snapshot,epoch=0,pending=null,effective='neutral',effectiveDigest='neutral-v1',initializing;
 const say=text=>{status.textContent=text;};
 const initialize=()=>{const ticket=epoch;return initializing??=import('./presentation-runtime.js').then(({PresentationRuntime})=>{if(ticket!==epoch||location.hash!=='#conversation'||document.hidden)throw new Error('Display is no longer active.');return runtime=new PresentationRuntime(section.querySelector('canvas'),{playback,identity:()=>({assistantId:identity?.()?.assistantId,endpointId:snapshot?.endpointId}),onFailure:say,onState:(state,_semantic,mapping)=>{section.querySelector('.presentation-state').textContent=mapping?.facePreview?'Face preview: '+mapping.facePreview:(mapping?.preview?'Preview: ':'')+state;if(mapping?.facePreview)previewStatus.textContent=`Face preview ${mapping.facePreview}: uses its declared mapping. No speech is generated.`;else if(mapping?.preview)previewStatus.textContent=`Preview ${state}: ${describe(mapping)}. No speech is generated.`;else if(previewStatus.textContent.startsWith('Preview ')||previewStatus.textContent.startsWith('Face preview '))previewStatus.textContent='Preview ended. Following the conversation again.';}});}).catch(error=>{initializing=null;throw error;});};
 const savedItem=(value=snapshot,inheritDefault=false)=>{
  const selected=(!inheritDefault&&value?.selection?.override)||value?.selection?.default;
  if(!selected)return value?.neutral;
  return [value.neutral,...value.packages].find(item=>item.id===selected.id&&item.digest===selected.digest);
 };
 const selectionSummary=()=>{
  inherit.disabled=!snapshot?.endpointId||!snapshot.selection?.override||!!pending;
  if(!snapshot){selectionStatus.textContent='';return;}
  const label=selection=>selection?[snapshot.neutral,...snapshot.packages].find(item=>item.id===selection.id&&item.digest===selection.digest)?.label??'Unavailable saved appearance':'Neutral reference';
  selectionStatus.textContent=snapshot.selection?.override?`Session override: ${label(snapshot.selection.override)}. Endpoint default: ${label(snapshot.selection.default)}. Saving an endpoint default keeps this session override.`:`Using endpoint default: ${label(snapshot.selection?.default)}. No session override.`;
 };
 const refresh=async()=>{
  if(!window.lifestreamAuth.session)return;const ticket=epoch,value=await api('/api/runtime/v1/presentation');if(ticket!==epoch)return;
  snapshot=value;const old=select.value;select.replaceChildren();for(const item of [value.neutral,...value.packages]){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;select.add(option);}
  const selected=value.selection?.override??value.selection?.default;select.value=[value.neutral,...value.packages].some(p=>p.id===selected?.id)?selected.id:old||'neutral';if(!select.value)select.value='neutral';button.disabled=!value.endpointId;selectionSummary();
  if(location.hash!=='#conversation'||document.hidden)return;await initialize();const item=savedItem();
  if(!item){say('Saved appearance changed or is unavailable. The current display is retained; choose and apply an available appearance explicitly.');return;}
  if((item.id!==effective||item.digest!==effectiveDigest)&&!busy())await apply(false);
 };
 const apply=async(save=true,clearOverride=false)=>{
  if(busy())throw new Error('Wait until the current turn and speech finish before changing appearance.');
  if(pending)throw new Error('An appearance is already loading.');
  const ticket=epoch,chosenScope=scope.value;
  const requested=clearOverride?savedItem(snapshot,true):save?[snapshot?.neutral,...snapshot?.packages??[]].find(item=>item?.id===select.value):savedItem();
  if(!requested)throw new Error('Saved appearance changed or is unavailable. Choose an available appearance and apply it explicitly.');
  const target=save&&!clearOverride&&chosenScope==='default'&&snapshot.selection?.override?savedItem():requested;
  if(!target)throw new Error('The session override changed or is unavailable. Reapply it or use an available endpoint default first.');
  const revision=clearOverride||chosenScope==='session'?snapshot.selection?.override?.revision??snapshot.selection?.overrideRevision??0:snapshot.selection?.default?.revision??0;
  const controller=pending=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Appearance loading timed out.')),30000),prepared=new Set();button.disabled=true;selectionSummary();let renderer;
  try{
   renderer=await initialize();say(`Loading ${requested.label}… Current appearance stays visible.`);
   const requestedCandidate=await renderer.prepare(requested,controller.signal);prepared.add(requestedCandidate);
   let candidate=requestedCandidate;
   if(target.id!==requested.id||target.digest!==requested.digest){candidate=null;if(target.id!==effective||target.digest!==effectiveDigest){candidate=await renderer.prepare(target,controller.signal);prepared.add(candidate);}}
   controller.signal.throwIfAborted();if(ticket!==epoch||busy())throw new Error('The conversation changed while loading. Try again between turns.');
   if(save){
    const body=clearOverride?{operation:'clearSessionOverride',expectedRevision:revision}:{scope:chosenScope,id:requested.id,digest:requested.digest,expectedRevision:revision};
    const next=await api('/api/runtime/v1/presentation',{method:'POST',body:JSON.stringify(body)});if(ticket!==epoch)throw new Error('The session changed before the appearance could be applied.');snapshot=next;if(busy())throw new Error('Selection saved; wait until the turn finishes, then refresh appearances.');
    const accepted=savedItem();if(!accepted||accepted.id!==target.id||accepted.digest!==target.digest)throw new Error('The effective selection changed during the save. Current display retained; refresh appearances before continuing.');
   }
   if(candidate){renderer.commit(candidate);prepared.delete(candidate);effective=target.id;effectiveDigest=target.digest;}
   say(`${target.label} · ${target.manifest?.capabilities.lipSync==='amplitude'||target.id==='neutral'?'Amplitude-driven mouth; no phoneme timing':'No live mouth mapping'}.`);
   if(clearOverride)select.value=target.id;
  }catch(error){say(`Requested ${requested.label}; current appearance retained. ${error.message}`);throw error;}
  finally{for(const candidate of prepared)renderer?.release(candidate);clearTimeout(timer);if(pending===controller)pending=null;button.disabled=!snapshot?.endpointId;selectionSummary();}
 };
 const run=fn=>()=>void fn().catch(error=>say(error.message));section.querySelector('[data-refresh]').onclick=run(refresh);button.onclick=run(()=>apply());inherit.onclick=run(()=>apply(true,true));
 section.querySelector('[data-preview]').onclick=run(async()=>{if(busy()||pending)throw new Error('Wait until the turn and appearance loading finish before previewing.');await initialize();if(busy()||pending)throw new Error('The conversation changed; preview was not started.');const state=section.querySelector('[aria-label="Animation preview state"]').value,mapping=runtime.preview(state);say(`${runtime.current.label} · appearance does not change identity or voice.`);previewStatus.textContent=`Preview ${state}: ${describe(mapping)}. No speech is generated.`;});
 section.querySelector('[data-face-preview]').onclick=run(async()=>{if(busy()||pending)throw new Error('Wait until the turn and appearance loading finish before previewing.');await initialize();if(busy()||pending)throw new Error('The conversation changed; preview was not started.');runtime.previewFace(section.querySelector('[aria-label="Face preview motion"]').value);say(`${runtime.current.label} · appearance does not change identity or voice.`);});
 section.querySelector('[data-end-preview]').onclick=()=>{runtime?.endPreview();previewStatus.textContent='Preview ended. Following the conversation again.';};
 const clear=()=>{previewStatus.textContent='No preview running.';epoch++;pending?.abort();pending=null;snapshot=null;effective='neutral';effectiveDigest='neutral-v1';runtime?.dispose();runtime=null;initializing=null;button.disabled=true;selectionSummary();select.replaceChildren(new Option('Neutral reference','neutral'));say('Sign in and apply a session endpoint to choose an appearance.');};
 const contextKey=()=>{const value=identity?.();return JSON.stringify([value?.assistantId??null,value?.relationshipId??null]);};
 let currentContext=contextKey();
 for(const event of ['lifestream-assistant','lifestream-relationship'])window.addEventListener(event,()=>{const next=contextKey();if(next===currentContext)return;currentContext=next;clear();void refresh().catch(error=>say(error.message));});
 for(const event of ['lifestream-auth','lifestream-session-context'])window.addEventListener(event,()=>{currentContext=contextKey();clear();void refresh().catch(error=>say(error.message));});
 const release=()=>{epoch++;pending?.abort();runtime?.dispose();runtime=null;initializing=null;effective='neutral';effectiveDigest='neutral-v1';};
 section.querySelector('[data-restart]').onclick=run(async()=>{if(busy())throw new Error('Wait until the turn finishes before restarting the display.');release();const old=section.querySelector('canvas'),fresh=old.cloneNode(false);old.replaceWith(fresh);await refresh();say('Display restarted. '+(runtime?.current?.label??'Neutral reference'));});
 window.addEventListener('hashchange',()=>{if(location.hash==='#conversation')void refresh().catch(error=>say(error.message));else release();});
 window.addEventListener('lifestream-audience',event=>{clear();if(event.detail?.privateAllowed&&location.hash==='#conversation')void refresh().catch(error=>say(error.message));});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)release();else if(location.hash==='#conversation')void refresh().catch(error=>say(error.message));});
 window.addEventListener('pagehide',()=>{clear();release();});
 return {refresh:run(refresh),clear,state(value){section.querySelector('.presentation-state').textContent=value;runtime?.applyState(value);},get pending(){return !!pending;}};
}
