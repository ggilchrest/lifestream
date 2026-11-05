import {setTimeout as delay} from 'node:timers/promises';
/** Per-run start-rate control only: no response deadline, retry, queue or
 * authority renewal. The existing owner must finish before another start. */
export function createGameDecisionStartGate(ports:{now?:()=>number;wait?:(ms:number,signal:AbortSignal)=>Promise<void>}={}){
 const now=ports.now??(()=>performance.now()),wait=ports.wait??((ms,signal)=>delay(ms,undefined,{signal}));let last=-Infinity,active:object|null=null;
 return Object.freeze({
  async start(signal:AbortSignal,current:()=>boolean){
   if(active)throw Error('Game decision already in flight');const token={};active=token;
   try{signal.throwIfAborted();if(!current())throw Error('Game decision scope unavailable');const remaining=5000-(now()-last);if(remaining>0)await wait(remaining,signal);signal.throwIfAborted();if(!current())throw Error('Game decision scope unavailable');last=now();return ()=>{if(active===token)active=null;};}
   catch(error){if(active===token)active=null;throw error;}
  },
 });
}
