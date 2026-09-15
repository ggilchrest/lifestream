import type { CapabilityCallContext } from './ports.js';
export class CapabilityCallError extends Error {
  readonly code: 'cancelled' | 'timedOut' | 'scopeChanged' | 'providerUnavailable' | 'invalidResponse';
  constructor(code: CapabilityCallError['code']) { super(`Capability call ${code}`); this.code=code; }
}
/** One finite deadline covers every await in an operation; late work cannot be consumed. */
export class CapabilityCall {
  readonly context: CapabilityCallContext;
  private readonly controller=new AbortController();
  private readonly expires: number;
  private readonly monotonicExpires: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(context: CapabilityCallContext) {
    this.expires=Date.parse(context.deadlineAt);
    const remaining=this.expires-Date.now();
    if(!["live","replay","simulation"].includes(context.executionMode)||!Number.isFinite(remaining)||remaining>30000||![context.requestId,context.correlationId].every(s=>typeof s==='string'&&s.length>0&&s.length<=128))throw new CapabilityCallError('invalidResponse');
    this.monotonicExpires=performance.now()+Math.max(0,remaining);
    this.context={...context,signal:AbortSignal.any([context.signal,this.controller.signal])};
    this.timer=setTimeout(()=>this.controller.abort(new CapabilityCallError('timedOut')),Math.max(1,remaining));
  }
  check():void {
    if(Date.now()>=this.expires||performance.now()>=this.monotonicExpires)throw new CapabilityCallError('timedOut');
    if(this.context.signal.aborted)throw new CapabilityCallError(this.controller.signal.aborted?'timedOut':'cancelled');
    let current=false;try{current=this.context.isCurrent();}catch{/* Unknown scope is unavailable. */}
    if(!current)throw new CapabilityCallError('scopeChanged');
  }
  async wait<T>(action:()=>Promise<T>):Promise<T>{
    this.check();let onAbort=()=>{};
    try{
      const value=await Promise.race([action(),new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new CapabilityCallError(this.controller.signal.aborted?'timedOut':'cancelled'));this.context.signal.addEventListener('abort',onAbort,{once:true});if(this.context.signal.aborted)onAbort();})]);
      this.check();return value;
    }catch(error){if(error instanceof CapabilityCallError)throw error;throw new CapabilityCallError('providerUnavailable');}
    finally{this.context.signal.removeEventListener('abort',onAbort);}
  }
  close():void {clearTimeout(this.timer);this.controller.abort();}
}
