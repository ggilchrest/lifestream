import {GameAdapterBoundaryError} from '@lifestream/providers-bizhawk';

/** One original observation attempt, including custody and acknowledgement.
 * The timer ends before the separate operator image-review wait. This owns no
 * permission, native lifetime, input lease, retry, or deadline renewal. */
export async function runGameObservationCommand<T>(maximumMs:number,parent:AbortSignal,work:(context:{signal:AbortSignal;deadlineAt:string;check:()=>void})=>Promise<T>):Promise<T>{
 if(!Number.isSafeInteger(maximumMs)||maximumMs<1||maximumMs>120000)throw new GameAdapterBoundaryError('invalidRequest');
 const wall=Date.now(),mono=performance.now(),controller=new AbortController(),signal=AbortSignal.any([parent,controller.signal]);
 const endWall=wall+maximumMs,endMono=mono+maximumMs;
 let timedOut=false,rejectAbort=()=>{};
 const check=()=>{
  if(timedOut||Date.now()>=endWall||performance.now()>=endMono)throw new GameAdapterBoundaryError('timedOut');
  if(parent.aborted)throw new GameAdapterBoundaryError('cancelled');
  if(Date.now()<wall||performance.now()<mono)throw new GameAdapterBoundaryError('scopeChanged');
 };
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},maximumMs);
 try{
  check();
  const result=await Promise.race([Promise.resolve().then(()=>{check();return work({signal,deadlineAt:new Date(endWall).toISOString(),check});}),new Promise<never>((_,reject)=>{
   rejectAbort=()=>reject(new GameAdapterBoundaryError(timedOut?'timedOut':'cancelled'));
   signal.addEventListener('abort',rejectAbort,{once:true});if(signal.aborted)rejectAbort();
  })]);
  check();return result;
 }finally{clearTimeout(timer);signal.removeEventListener('abort',rejectAbort);controller.abort();}
}
