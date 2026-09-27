// Render only observed native stages; a lit lamp does not claim successful delivery.
export function renderActivity(state={},text={}) {
 const $=id=>document.getElementById(id);
 const lamp=(id,label,kind='off')=>{$(id+'-status').textContent=label;$(id+'-light').dataset.state=kind;};
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:undefined;
 const raw=count(state.rawInputBuffers),converted=count(state.convertedInputBuffers),delivered=count(state.inputFrames);
 let input=state.inputStage??(state.active?(delivered>0?'listening':'starting'):'off');
 if(state.active&&!(delivered>0)&&input==='listening')input='starting';
 const inputs={off:['Off','off'],starting:['Starting','waiting'],listening:['Listening','ready'],capturing:['Speech detected','active'],waiting:['Waiting for reply','waiting'],error:['Input error','error']};
 if(input==='starting')inputs.starting=raw>0&&converted===0?['Waiting for conversion','waiting']:state.captureEngineRunning===true?['Waiting for audio','waiting']:inputs.starting;
 lamp('input',...(inputs[input]??['Unknown','waiting']));
 $('input-level').value=Math.min(1,Math.max(0,Number(state.inputLevel)||0)*12);
 const backends={idle:['Idle','off'],connecting:['Connecting','waiting'],transcribing:['Transcribing','active'],generating:['Generating reply','active'],error:['Backend error','error']};
 const outputs={idle:['Idle','off'],buffering:['Preparing speech','waiting'],playing:['Playing speech','active'],error:['Output error','error']};
 lamp('backend',...(text.busy?['Processing text','active']:text.error?['Request failed','error']:backends[state.backendStage]??['Idle','off']));
 lamp('output',...(text.complete?['Text received','ready']:outputs[state.outputStage]??['Idle','off']));
 let detail='Microphone is off. You can also send a typed message.';
 if(state.active){
  if(delivered>0)detail='Microphone audio is reaching the app. Silence alone is not speech. Speak, then pause to send.';
  else if(converted>0)detail='Audio conversion is producing buffers; waiting for delivery to the app.';
  else if(raw>0&&converted===0)detail='Microphone buffers are arriving; waiting for audio conversion.';
  else detail=state.captureEngineRunning===false?'Audio engine is starting; waiting for microphone buffers.':'Waiting for microphone buffers.';
 }
 const counters=[[raw,'raw'],[converted,'converted'],[delivered,'delivered']].filter(([value])=>value!==undefined).map(([value,label])=>`${value} ${label}`);
 const format=[];if(Number.isFinite(state.captureSampleRate)&&state.captureSampleRate>0)format.push(`${state.captureSampleRate} Hz`);
 if(count(state.captureChannels)>0)format.push(`${state.captureChannels} channel${state.captureChannels===1?'':'s'}`);
 $('audio-detail').textContent=[state.lastError||detail,...(counters.length?[`Buffers: ${counters.join(' · ')}.`]:[]),...(format.length?[format.join(' · ')+'.']:[])].join(' ');
}
