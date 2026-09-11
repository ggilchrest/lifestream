import {setTimeout as delay} from 'node:timers/promises';

// Bound delivery lookahead independently of packet count. This is transport
// pacing, not proof of browser consumption or an excuse to drop late speech.
export class PcmPacer {
  private cursor=0;
  async admit(samples:number,rate:number,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();
    if(!Number.isInteger(samples)||samples<1||samples>rate)throw new Error('PCM packet exceeds one second');
    const wait=this.cursor-performance.now()-1500;
    if(wait>0)await delay(wait,undefined,{signal});
    signal.throwIfAborted();
    this.cursor=Math.max(this.cursor,performance.now())+samples/rate*1000;
  }
}
