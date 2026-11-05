import type {Server} from 'node:net';

/** Fixed local server setup only. Closing/cancelling during bind must settle the
 * caller, and a late bind cannot leave a successor listener behind. */
export function startNativeListener(server:Server,port:number,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  let settled=false;
  const close=()=>{try{server.close(()=>{});}catch{/* Never retry a native action. */}};
  const cleanup=()=>{server.off('listening',opened);server.off('error',failed);server.off('close',ended);signal.removeEventListener('abort',aborted);};
  const failed=(reason:unknown)=>{
   if(settled)return;settled=true;cleanup();
   // Some platform binds can complete after cancellation. Preserve one close
   // observer for exactly that original server, never reopen/retry the bind.
   if(!server.listening)server.once('listening',close);close();reject(reason);
  };
  const opened=()=>{if(signal.aborted){failed(Error('Original native listener cancelled'));return;}settled=true;cleanup();resolve();};
  const ended=()=>failed(Error('Original native listener closed during setup'));
  const aborted=()=>failed(Error('Original native listener cancelled'));
  server.once('listening',opened);server.once('error',failed);server.once('close',ended);signal.addEventListener('abort',aborted,{once:true});
  if(signal.aborted){aborted();return;}
  try{server.listen({host:'127.0.0.1',port,exclusive:true});}catch(error){failed(error);}
 });
}
