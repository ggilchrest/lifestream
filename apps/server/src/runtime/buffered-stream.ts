// One producer; bounded transport lookahead, not parallel model generation.
// Provider PCM packets are <=100 ms, so 64 events retain at most 6.4 s audio.
export async function* bufferedStream<T>(source:AsyncIterable<T>,signal:AbortSignal,capacity=64,onStop?:()=>void):AsyncGenerator<T>{
  const values:T[]=[];let ended=false,error:unknown,wake:(()=>void)|undefined,space:(()=>void)|undefined,stopped=false;
  const abort=()=>{stopped=true;wake?.();space?.();};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const producer=(async()=>{
    try{for await(const value of source){while(!stopped&&values.length>=capacity)await new Promise<void>(resolve=>{space=resolve;});if(stopped)break;values.push(value);wake?.();wake=undefined;}}
    catch(reason){error=reason;}
    finally{ended=true;wake?.();}
  })();
  try{
    while(true){signal.throwIfAborted();if(error)throw error;const value=values.shift();if(value!==undefined){space?.();space=undefined;yield value;continue;}if(ended)return;await new Promise<void>(resolve=>{wake=resolve;});}
  }finally{abort();if(!ended)onStop?.();signal.removeEventListener('abort',abort);await producer;}
}
