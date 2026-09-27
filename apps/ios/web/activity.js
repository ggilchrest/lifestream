// Render only observed native stages; a lit lamp does not claim successful delivery.
export function renderActivity(state={},text={}) {
 const $=id=>document.getElementById(id);
 const lamp=(id,label,kind='off')=>{$(id+'-status').textContent=label;$(id+'-light').dataset.state=kind;};
 const input=state.inputStage??(state.active?'listening':'off');
 const inputs={off:['Off','off'],starting:['Starting','waiting'],listening:['Listening','ready'],capturing:['Speech detected','active'],waiting:['Waiting for reply','waiting'],error:['Input error','error']};
 lamp('input',...(inputs[input]??['Unknown','waiting']));
 $('input-level').value=Math.min(1,Math.max(0,Number(state.inputLevel)||0)*12);
 const backends={idle:['Idle','off'],connecting:['Connecting','waiting'],transcribing:['Transcribing','active'],generating:['Generating reply','active'],error:['Backend error','error']};
 const outputs={idle:['Idle','off'],buffering:['Preparing speech','waiting'],playing:['Playing speech','active'],error:['Output error','error']};
 lamp('backend',...(text.busy?['Processing text','active']:text.error?['Request failed','error']:backends[state.backendStage]??['Idle','off']));
 lamp('output',...(text.complete?['Text received','ready']:outputs[state.outputStage]??['Idle','off']));
 $('audio-detail').textContent=state.lastError|| (state.active ? (state.inputFrames>0?'Microphone signal is reaching the app. Speak, then pause to send.':'Waiting for microphone audio…'):'Microphone is off. You can also send a typed message.');
}
