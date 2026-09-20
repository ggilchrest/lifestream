// Reports local software settlement only. Missing reports retain the server lease until expiry.
export function previewPlayback(response,headers,stop) {
 const trace=response.headers.get('x-lifestream-playback-trace'),expires=Date.parse(response.headers.get('x-lifestream-playback-expires'));
 if(!/^[0-9a-f-]{36}$/i.test(trace??'')||!Number.isFinite(expires))throw Error('Preview playback ownership was not established.');
 let samples=0,settlement;
 const timer=setTimeout(stop,Math.max(1,Math.min(180000,expires-Date.now())));
 return {
  received(count){if(!Number.isSafeInteger(count)||count<0||samples+count>8640000)throw Error('Invalid preview playback samples.');samples+=count;},
  finish(outcome){
   if(settlement)return settlement;clearTimeout(timer);
   settlement=fetch('/api/runtime/v1/tts/playback',{method:'POST',credentials:'same-origin',headers:{...headers,'content-type':'application/json'},keepalive:true,signal:AbortSignal.timeout(5000),body:JSON.stringify({type:'playbackSettled',interactionTraceId:trace,outcome,receivedSamples:samples})}).then(r=>r.ok,()=>false);
   return settlement;
  }
 };
}
