const fixtureState={assistantName:'Atlas',speechState:'listening',activity:'conversing',attention:'participant',engagement:'engaged',urgency:'normal',sequence:12,expiresAt:null,rendererReady:true};
const label=value=>String(value).replace(/([A-Z])/g,' $1').replace(/^./,char=>char.toUpperCase());
const setText=(id,value)=>{document.getElementById(id).textContent=value;};
function renderPresence(state){
  setText('assistant-name',state.assistantName+' presence');
  setText('presence-title',label(state.activity));
  const summaries={listening:'Listening for you.',speaking:'Speaking from confirmed endpoint playback.',working:'Working on the current task.',error:'The renderer reports an error state.'};
  setText('presence-summary',summaries[state.speechState]??summaries[state.activity]??'Available.');
  setText('speech-state',label(state.speechState));setText('activity-state',label(state.activity));setText('attention-state',label(state.attention));setText('engagement-state',label(state.engagement));setText('urgency-state',label(state.urgency));setText('sequence','Sequence '+state.sequence);setText('expiry-state',state.expiresAt?('Expires '+state.expiresAt):'No expiry');setText('renderer-status',state.rendererReady?'Renderer ready':'Renderer degraded');setText('renderer-note',state.rendererReady?'Visual details stay local to the renderer.':'Semantic state remains available while rendering is degraded.');
}
renderPresence(fixtureState);
