import {AudioPlayback} from './audio-playback.ts';

type Owner={principalId:string;sessionId:string};
/** Ephemeral, bounded preview custody; no voice review or Human reception claim. */
export class PreviewPlayback {
 private readonly active=new Map<string,{owner:Owner;playback:AudioPlayback}>();
 begin(trace:string,owner:Owner,deadlineAt:string,stop:()=>void,release:()=>void):AudioPlayback {
  if(this.active.size>=256||this.active.has(trace))throw Error('Preview playback capacity unavailable');
  const playback=new AudioPlayback(trace,deadlineAt,stop);this.active.set(trace,{owner:{...owner},playback});
  void playback.settled.then(()=>{this.active.delete(trace);release();});return playback;
 }
 acknowledge(owner:Owner,message:unknown):boolean {
  if(!message||typeof message!=='object'||Array.isArray(message))return false;
  const trace=(message as Record<string,unknown>).interactionTraceId;if(typeof trace!=='string')return false;
  const current=this.active.get(trace);
  return !!current&&current.owner.principalId===owner.principalId&&current.owner.sessionId===owner.sessionId&&current.playback.acknowledge(message);
 }
}
