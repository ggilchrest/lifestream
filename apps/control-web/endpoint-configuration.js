// Derived inspection only. All edits remain in their existing administration surfaces.
export function installEndpointConfiguration({anchor,api,context}) {
 anchor.id='endpoint-configuration-panel';anchor.className='card endpoint-configuration';
 anchor.innerHTML='<h2>Effective endpoint configuration</h2><p>Inspect the saved choices and current session that govern this endpoint. This does not start playback or change a setting.</p><div class="actions"><button type="button" data-effective-refresh>Refresh effective settings</button><button type="button" class="secondary" data-effective-route="profile">Assistant profile</button><button type="button" class="secondary" data-effective-route="voice">Saved voice</button><button type="button" class="secondary" data-effective-route="conversation">Conversation & appearance</button></div><p data-effective-status role="status"></p><dl data-effective-values></dl><details><summary>Sources, revisions and limits</summary><pre class="context-inspector" data-effective-details></pre></details>';
 const $=s=>anchor.querySelector(s);let epoch=0;const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
 const permitted=()=>window.lifestreamAuth?.mode==='local-password'&&!!window.lifestreamAuth.session&&document.documentElement.dataset.audienceProtected!=='true'&&!document.hidden;
 const clear=()=>{$('[data-effective-values]').replaceChildren();$('[data-effective-details]').textContent='';};
 const row=(label,text)=>{const term=document.createElement('dt'),value=document.createElement('dd');term.textContent=label;value.textContent=text;$('[data-effective-values]').append(term,value);};
 const refresh=async()=>{
  const ticket=++epoch;clear();anchor.hidden=!permitted();if(anchor.hidden)return;
  const assistantId=context()?.assistantId??null,sessionId=window.lifestreamAuth.session.sessionId;
  $('[data-effective-status]').textContent='Reading current settings…';
  try {
   const value=await api('/api/runtime/v1/endpoint-configuration'+(assistantId?'?assistantId='+encodeURIComponent(assistantId):''));
   if(ticket!==epoch||!permitted()||sessionId!==window.lifestreamAuth.session?.sessionId||assistantId!==(context()?.assistantId??null))return;
   const e=value.session;
   row('Endpoint',e.endpointId?`${e.endpointClass} · revision ${e.endpointRevision}`:'Unbound. Apply Session Disclosure first.');
   row('Assistant',value.assistant.profileRevision?`Active profile revision ${value.assistant.profileRevision}; identity and persona preserved.`:assistantId?'No active profile. Review Assistant profile.':'Select an Assistant to inspect its active profile and saved voice.');
   row('Private context',`${value.disclosure.effectiveScope==='authenticatedSession'?'Allowed by disclosure and audience':'Withheld'} · session revision ${e.revision}. Physical speaker identity: ${value.disclosure.speakerIdentity}.`);
   row('Negotiated modalities',`Input: ${value.modalities.negotiatedInput.join(', ')||'none'}; output: ${value.modalities.negotiatedOutput.join(', ')||'none'}. This does not establish physical capture or audibility.`);
   row('Providers',`Inference: ${value.modalities.inference}; speech recognition: ${value.modalities.speechRecognition}; speech generation: ${value.modalities.speechGeneration}.`);
   row('Voice',value.voice.compatible?`${value.voice.source==='activeAssistantVoice'?'Active Assistant voice':'Configured default'} · revision ${value.voice.revision}. Per-turn overrides are shown in Conversation.`:value.voice.reason);
   row('Appearance',`${value.presentation.label} · ${value.presentation.source==='sessionOverride'?'session override':value.presentation.source==='endpointDefault'?'endpoint default':'neutral fallback'} · revision ${value.presentation.selected.revision}. ${value.presentation.reason??'Saved choice available; current renderer playback is local to the endpoint.'}`);
   row('Audio ownership',value.audioOwnership.active?`One current-session lease · revision ${value.audioOwnership.revision}. Physical playback is unverified.`:'No active audio lease in this session.');
   row('Handoff',value.handoff.reason);
   row('Accessibility & interruption',`Reduced motion: ${motionPreference.matches?'on for this display; automatic body and face motion paused. Explicit five-second previews and playback-driven mouth movement remain available':'off for this display; standard motion'}. This is the local browser preference, not a server or physical audience observation. Conversation has Stop response & speech and microphone controls; physical interruption remains separately verified.`);
   $('[data-effective-details]').textContent=JSON.stringify(value,null,2);
   $('[data-effective-status]').textContent='Current read-only snapshot. Refresh after changes in another tab.';
  }catch(error){if(ticket===epoch){clear();$('[data-effective-status]').textContent='Effective settings unavailable. '+error.message;}}
 };
 $('[data-effective-refresh]').onclick=()=>void refresh();
 for(const button of anchor.querySelectorAll('[data-effective-route]'))button.onclick=()=>window.lifestreamUI?.navigate(button.dataset.effectiveRoute);
 const changed=()=>{epoch++;clear();anchor.hidden=!permitted();if(!anchor.hidden&&location.hash==='#session')void refresh();};
 for(const event of ['lifestream-auth','lifestream-assistant','lifestream-session-context','lifestream-audience','hashchange'])window.addEventListener(event,changed);
 motionPreference.addEventListener('change',changed);document.addEventListener('visibilitychange',changed);window.addEventListener('pagehide',()=>{epoch++;clear();anchor.hidden=true;});
 void window.lifestreamAuth.ready.then(changed);
}
