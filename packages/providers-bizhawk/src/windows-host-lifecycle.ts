/** In-process lifecycle only. The authenticated session port and agreed Linux
 * codec are injected by trusted desktop/main code, never reconstructed from
 * renderer messages, CLI arguments, cookies or an IPC-presence assertion.
 * This module defines no wire messages and creates no socket/emulator/key. */
export const WINDOWS_HOST_BACKEND_URL='http://127.0.0.1:43182' as const;
export type WindowsHostFenceReason='denied'|'cancelled'|'connectionDeadline'|'scopeChanged'|'disconnected'|'sessionEnded'|'expired'|'closed';
export class WindowsHostLifecycleError extends Error{
 readonly code:WindowsHostFenceReason|'unconfigured';
 constructor(code:WindowsHostFenceReason|'unconfigured'){super('Windows host unavailable: '+code);this.code=code;}
}
export interface OwnedHostConnection{close():void;}
export interface WindowsHostContext{
 readonly backendUrl:typeof WINDOWS_HOST_BACKEND_URL;
 readonly signal:AbortSignal;
 /** Call before each dispatch. Connection presence is not effect authority. */
 assertSessionCurrent():void;
}
export interface WindowsHostLifecycleOptions<Connection extends OwnedHostConnection>{
 /** Trusted main/session code must authenticate and bind current owner/scope. */
 connectAuthenticated(context:WindowsHostContext):Promise<Connection>;
 isSessionCurrent():boolean;
 /** Synchronously fence new effects and pursue exact-lease shutdown. This
  * notification is never evidence of neutralization, pause or reconciliation. */
 onFence(reason:WindowsHostFenceReason):void;
 /** Absent until the shared typed RPC contract is supplied. No fallback codec. */
 driveContract?:(connection:Connection,context:WindowsHostContext)=>Promise<void>;
 connectionTimeoutMs:number;
 sessionDurationMs:number;
}
function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((accept,reject)=>{
 const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
 if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
 promise.then(value=>{signal.removeEventListener('abort',abort);accept(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
});}
/** A single attempt, finite session and no reconnect/redispatch. Opaque generic
 * Connection avoids inventing the not-yet-agreed external RPC representation. */
export class WindowsHostLifecycle<Connection extends OwnedHostConnection>{
 private readonly options:Readonly<WindowsHostLifecycleOptions<Connection>>|undefined;
 private readonly controller=new AbortController();private connection:Connection|undefined;
 private started=false;private state:'unconfigured'|'idle'|'connecting'|'connected'|'closed';
 private reason:WindowsHostFenceReason|undefined;private fenceRequested=false;
 private connectionTimer:ReturnType<typeof setTimeout>|undefined;private sessionTimer:ReturnType<typeof setTimeout>|undefined;
 private parent:AbortSignal|undefined;private parentAbort:()=>void=()=>this.close('cancelled');
 constructor(options?:WindowsHostLifecycleOptions<Connection>){
  if(options&&(typeof options.connectAuthenticated!=='function'||typeof options.isSessionCurrent!=='function'||typeof options.onFence!=='function'||options.driveContract!==undefined&&typeof options.driveContract!=='function'||!Number.isSafeInteger(options.connectionTimeoutMs)||options.connectionTimeoutMs<1||options.connectionTimeoutMs>10000||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<options.connectionTimeoutMs||options.sessionDurationMs>600000))throw new WindowsHostLifecycleError('unconfigured');
  this.options=options?Object.freeze({...options}):undefined;this.state=options?.driveContract?'idle':'unconfigured';
 }
 get snapshot(){return Object.freeze({state:this.state,attempted:this.started,contractConfigured:typeof this.options?.driveContract==='function',backendUrl:WINDOWS_HOST_BACKEND_URL,fenceRequested:this.fenceRequested,reason:this.reason,pauseConfirmation:'unconfirmed' as const});}
 assertSessionCurrent():void{
  let current=false;try{current=this.options?.isSessionCurrent()===true;}catch{}
  if(this.state==='closed')throw new WindowsHostLifecycleError(this.reason??'closed');
  if(!current){this.close('scopeChanged');throw new WindowsHostLifecycleError('scopeChanged');}
 }
 close(reason:WindowsHostFenceReason='closed'):void{
  if(this.state==='closed')return;this.state='closed';this.reason=reason;
  clearTimeout(this.connectionTimer);clearTimeout(this.sessionTimer);this.parent?.removeEventListener('abort',this.parentAbort);
  // Fence before notifying asynchronous transport/codec work of cancellation.
  if(this.started&&this.options){this.fenceRequested=true;try{this.options.onFence(reason);}catch{}}
  this.controller.abort(new WindowsHostLifecycleError(reason));
  const connection=this.connection;this.connection=undefined;try{connection?.close();}catch{}
 }
 async start(parent?:AbortSignal):Promise<void>{
  if(this.started||this.state==='closed')throw new WindowsHostLifecycleError('closed');
  const options=this.options;if(!options?.driveContract)throw new WindowsHostLifecycleError('unconfigured');
  this.started=true;
  let current=false;try{current=options.isSessionCurrent()===true;}catch{}
  if(!current){this.close('denied');throw new WindowsHostLifecycleError('denied');}
  this.parent=parent;if(parent?.aborted){this.close('cancelled');throw new WindowsHostLifecycleError('cancelled');}parent?.addEventListener('abort',this.parentAbort,{once:true});
  const context:WindowsHostContext=Object.freeze({backendUrl:WINDOWS_HOST_BACKEND_URL,signal:this.controller.signal,assertSessionCurrent:()=>this.assertSessionCurrent()});
  this.state='connecting';this.connectionTimer=setTimeout(()=>this.close('connectionDeadline'),options.connectionTimeoutMs);this.sessionTimer=setTimeout(()=>this.close('expired'),options.sessionDurationMs);
  try{
   const opening=Promise.resolve().then(()=>{context.assertSessionCurrent();return options.connectAuthenticated(context);}).then(connection=>{
    if(!connection||typeof connection.close!=='function')throw new WindowsHostLifecycleError('unconfigured');
    if(this.state==='closed'){try{connection.close();}catch{}throw new WindowsHostLifecycleError(this.reason??'closed');}
    this.connection=connection;return connection;
   });void opening.catch(()=>{});
   const connection=await bounded(opening,this.controller.signal);clearTimeout(this.connectionTimer);context.assertSessionCurrent();this.state='connected';
   await bounded(Promise.resolve().then(()=>{context.assertSessionCurrent();return options.driveContract!(connection,context);}),this.controller.signal);
   this.close('sessionEnded');
  }catch(error){this.close(error instanceof WindowsHostLifecycleError&&error.code!=='unconfigured'?error.code:'disconnected');throw new WindowsHostLifecycleError(this.reason??'disconnected');}
 }
}
/** Mechanism check only: a Node inherited IPC channel does not prove sender
 * identity, login, pairing, source qualification or a grant to control input. */
export function inheritedHostIpcAvailable(value:{connected?:boolean;send?:unknown}):boolean{return value.connected===true&&typeof value.send==='function';}
