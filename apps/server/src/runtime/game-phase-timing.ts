import {types} from 'node:util';
/** Opt-in metadata around existing operations. Never a currentness cache or
 * an authority decision; exceptions and original return values pass through. */
const phases=new Set(['source-refresh','observation','vision','settlement']);
export function gamePhase<T>(runId:string,phase:string,work:()=>Promise<T>):Promise<T>{
 if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS!=='1'||!phases.has(phase))return work();
 const started=performance.now();let outcome='failed';
 return (async()=>{try{const value=await work();outcome='returned';return value;}finally{try{console.info(JSON.stringify({event:'game-operation-timing',runId,phase,outcome,elapsedMs:Math.round((performance.now()-started)*100)/100}));}catch{}}})();
}

/** Failure location only; never arbitrary exception text, prompt or native credentials. */
export function gamePreparationFailure(runId:string,phase:string,error:unknown):void{
 if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS!=='1')return;
 try{if(!error||typeof error!=='object'||types.isProxy(error))return;
  const stack=Object.getOwnPropertyDescriptor(error,'stack'),value=stack&&Object.hasOwn(stack,'value')?stack.value:null;
  const source=typeof value==='string'?value.match(/(?:apps|packages|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs):[0-9]+:[0-9]+/)?.[0]:undefined;
  const message=Object.getOwnPropertyDescriptor(error,'message')?.value;const reasons:Record<string,string>={'Authenticated game runtime unavailable':'runtime_unavailable','Prepared game context is unavailable or does not match its logical activity view':'game_context_unavailable','Finalized turn is unavailable or does not match its prepared binding':'finalized_turn_unavailable','relationship scope unavailable':'relationship_unavailable','runtime scope unavailable':'runtime_scope_unavailable','Owned game media unavailable':'media_source_unavailable','Owned media directory changed':'media_directory_changed','Game media identity unavailable':'media_metadata_absent','Game media identity changed':'media_metadata_mismatch','Game media truncated':'media_truncated'};
  console.info(JSON.stringify({event:'game-planning-preparation-failure',runId,phase,...(source?{source}:{}),reason:typeof message==='string'?reasons[message]??'unclassified':'unclassified'}));
 }catch{} // Diagnostic sinks cannot replace the original failure.
}
