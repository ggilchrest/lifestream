type Hint={boundary:string;opportunityId:string;observedAt:number};
export type TimingPlan={delayMs:number;sourceRef:string};
/** Explicit, one-use timing feedback. No inferred mood, learned preference or durable setting. */
export class InitiativeTiming {
 private readonly hints=new Map<string,Hint>();private readonly now:()=>number;
 constructor(now:()=>number=()=>Date.now()){this.now=now;}
 prune(){const now=this.now();for(const [key,hint]of this.hints)if(now<hint.observedAt||now-hint.observedAt>=86400000)this.hints.delete(key);}
 note(key:string,boundary:string,opportunityId:string){this.prune();if(this.hints.size>=256&&!this.hints.has(key))return;this.hints.set(key,{boundary,opportunityId,observedAt:this.now()});}
 peek(key:string,boundary:string,adaptation:unknown):TimingPlan|undefined {
  this.prune();const hint=this.hints.get(key),settings=adaptation as {enabled?:unknown;maximumDeferralSeconds?:unknown}|undefined;
  if(hint&&hint.boundary!==boundary){this.hints.delete(key);return undefined;}
  if(!hint||settings?.enabled!==true||!Number.isInteger(settings.maximumDeferralSeconds)||Number(settings.maximumDeferralSeconds)<=0||Number(settings.maximumDeferralSeconds)>60)return undefined;
  return {delayMs:Number(settings.maximumDeferralSeconds)*1000,sourceRef:`timing-plan:${hint.opportunityId}:${settings.maximumDeferralSeconds}`};
 }
 take(key:string,boundary:string,adaptation:unknown){const result=this.peek(key,boundary,adaptation);if(result)this.hints.delete(key);return result;}
 clear(key?:string){if(key)this.hints.delete(key);else this.hints.clear();}
}
export function waitForInitiativeTiming(delayMs:number,signal:AbortSignal):Promise<void>{
 if(!Number.isInteger(delayMs)||delayMs<1||delayMs>60000)return Promise.reject(new Error('Invalid timing delay'));
 return new Promise((resolve,reject)=>{if(signal.aborted){reject(new Error('Initiative timing cancelled'));return;}const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('Initiative timing cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delayMs);signal.addEventListener('abort',abort,{once:true});});
}
