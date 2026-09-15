import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import type {InitiativeLabReport} from './initiative-lab-worker.ts';
type Entry={key:string;boundary:string;settingsDigest:string;expires:number;report?:InitiativeLabReport;error?:string};
/** One bounded, synthetic-only worker. No account prose, provider or database handle crosses this boundary. */
export class InitiativeLab {
 private entry:Entry|undefined;private worker:Worker|undefined;private timer:ReturnType<typeof setTimeout>|undefined;private closed=false;private expiry:ReturnType<typeof setTimeout>|undefined;
 readOrStart(key:string,boundary:string,settings:Record<string,unknown>):Entry {
  if(this.closed)throw new Error('Initiative Lab is closed');
  const settingsDigest=createHash('sha256').update(JSON.stringify(settings)).digest('hex'),prior=this.entry;
  if(prior?.key===key&&prior.boundary===boundary&&prior.settingsDigest===settingsDigest&&prior.expires>Date.now())return prior;
  if(this.worker)throw new Error('An isolated Initiative comparison is running. Retry after it finishes.');
  // Retain only permission presence; account endpoint and consent identifiers stay outside the worker.
  const synthetic={...structuredClone(settings),endpointIds:(settings.endpointIds as string[]).length?['synthetic-endpoint']:[],consentRefs:(settings.consentRefs as string[]).length?['synthetic-consent']:[]};
  const entry:Entry={key,boundary,settingsDigest,expires:Date.now()+600000};this.entry=entry;clearTimeout(this.expiry);this.expiry=setTimeout(()=>{if(this.entry===entry)this.entry=undefined;},600000);this.expiry.unref();
  const worker=new Worker(new URL(`./initiative-lab-worker.${import.meta.url.endsWith('.ts')?'ts':'js'}`,import.meta.url),{workerData:{settings:synthetic},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});this.worker=worker;
  worker.on('message',(value:{report?:InitiativeLabReport;error?:string})=>{if(this.entry!==entry||entry.error)return;if(value.report)entry.report=value.report;else entry.error='Isolated comparison failed; no live state changed.';});
  worker.on('error',()=>{if(this.entry===entry)entry.error='Isolated comparison worker failed; no live state changed.';});
  worker.on('exit',()=>{if(this.entry===entry&&!entry.report&&!entry.error)entry.error='Isolated comparison ended without a complete report.';if(this.worker===worker){this.worker=undefined;clearTimeout(this.timer);this.timer=undefined;}});
  this.timer=setTimeout(()=>{entry.error='Isolated comparison exceeded its ten-second execution limit.';void worker.terminate();},10000);this.timer.unref();worker.unref();return entry;
 }
 close(){this.closed=true;clearTimeout(this.expiry);this.entry=undefined;clearTimeout(this.timer);this.timer=undefined;if(this.worker)void this.worker.terminate();this.worker=undefined;}
}
