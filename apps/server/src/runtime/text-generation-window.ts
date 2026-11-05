/** Host-authored typed-text sanity bounds, never an authorization/source lease.
 * The immutable total ceiling is fixed at original preparation. Only nonempty
 * admitted text resets the no-progress timer; Stop/owner/source loss never does.
 */
export const textGenerationTiming=Object.freeze({maximumDurationMs:600000,noProgressMs:120000});
export function textProgressWindow(controller:AbortController){
 let timer:ReturnType<typeof setTimeout>|undefined,closed=false;
 const clear=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
 const progress=()=>{if(closed||controller.signal.aborted)return;clear();timer=setTimeout(()=>{if(!closed&&!controller.signal.aborted)controller.abort(new Error('inference_stalled'));},textGenerationTiming.noProgressMs);};
 const close=()=>{closed=true;clear();controller.signal.removeEventListener('abort',clear);};
 controller.signal.addEventListener('abort',clear,{once:true});progress();
 return Object.freeze({progress,close});
}
