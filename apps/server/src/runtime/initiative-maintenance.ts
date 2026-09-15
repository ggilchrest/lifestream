export const initiativeRetentionCadence={idleMs:60000,catchUpMs:1000,batchSize:128} as const;
type Counts={inferenceRemoved:number;deliveryRemoved:number};
/** Bounded local metadata cleanup only. No opportunity generation or provider work. */
export class InitiativeMaintenance {
 private readonly prune:()=>Counts;private timer:ReturnType<typeof setTimeout>|undefined;private closed=false;
 private status:'scheduled'|'healthy'|'degraded'|'stopped'='scheduled';
 constructor(prune:()=>Counts){this.prune=prune;this.schedule(1);}
 private schedule(delay:number){if(this.closed)return;this.timer=setTimeout(()=>this.run(),delay);this.timer.unref?.();}
 private run(){
  this.timer=undefined;if(this.closed)return;let delay:number=initiativeRetentionCadence.idleMs;
  try{const counts=this.prune();this.status='healthy';if(counts.inferenceRemoved>=initiativeRetentionCadence.batchSize||counts.deliveryRemoved>=initiativeRetentionCadence.batchSize)delay=initiativeRetentionCadence.catchUpMs;}
  catch{this.status='degraded';}
  this.schedule(delay);
 }
 state(){return this.status;}
 close(){this.closed=true;clearTimeout(this.timer);this.timer=undefined;this.status='stopped';}
}
