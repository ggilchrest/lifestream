// Qualification sinks collect/discard PCM. They never claim endpoint playback.
export async function discardPreview(response,events,base,headers) {
 const interactionTraceId=response.headers.get('x-lifestream-playback-trace');
 if(!interactionTraceId)throw Error('Preview did not provide playback custody');
 const result=await fetch(base+'/api/runtime/v1/tts/playback',{method:'POST',headers,signal:AbortSignal.timeout(5000),body:JSON.stringify({type:'playbackSettled',interactionTraceId,outcome:'stopped',receivedSamples:events.filter(e=>e.kind==='data').reduce((sum,e)=>sum+e.frame.sampleCount,0)})});
 if(!result.ok)throw Error('Preview discard was not acknowledged: '+result.status);
}
