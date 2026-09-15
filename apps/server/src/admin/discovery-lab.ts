import {Worker} from 'node:worker_threads';
import {understandingDigest} from '@lifestream/storage-sqlite';
import type {RelationshipConfiguration} from '../relationship-extensions.ts';
import type {DiscoveryLabReport} from './discovery-lab-worker.ts';

type Entry={key:string;boundary:string;configurationDigest:string;expires:number;report?:DiscoveryLabReport;error?:string};
/** One bounded worker per runtime; no provider, live database or private evidence crosses the boundary. */
export class DiscoveryInputLab {
 private entry:Entry|undefined;
 private worker:Worker|undefined;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private closed=false;
 readOrStart(key:string,boundary:string,configuration:RelationshipConfiguration):Entry {
  if(this.closed)throw new Error('Discovery Lab is closed');
  const configurationDigest=understandingDigest(configuration),previous=this.entry;
  if(previous?.key===key&&previous.boundary===boundary&&previous.configurationDigest===configurationDigest&&previous.expires>Date.now())return previous;
  if(this.worker)throw new Error('One isolated comparison is already running; retry after it finishes');
  const entry:Entry={key,boundary,configurationDigest,expires:Date.now()+600000};this.entry=entry;
  const worker=new Worker(new URL(`./discovery-lab-worker.${import.meta.url.endsWith('.ts')?'ts':'js'}`,import.meta.url),{workerData:{configuration:{configurationId:configuration.configurationId,relationshipId:'00000000-0000-4000-8000-000000000003',revision:configuration.revision,status:configuration.status,preset:configuration.preset,controls:configuration.controls,representation:configuration.representation??'recordOriented',createdBy:'synthetic-lab',createdAt:'2000-01-01T00:00:00.000Z',extensions:{understanding:configuration.extensions?.understanding}}},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4}});this.worker=worker;
  const clear=()=>{if(this.worker!==worker)return;this.worker=undefined;if(this.timer)clearTimeout(this.timer);this.timer=undefined;};
  worker.on('message',(value:{report?:DiscoveryLabReport;error?:string})=>{if(this.entry!==entry)return;if(value.report)entry.report=value.report;else entry.error='Isolated comparison failed before completing its input checks.';});
  worker.on('error',()=>{if(this.entry===entry)entry.error='Isolated comparison worker failed; no live state changed.';});
  worker.on('exit',code=>{if(this.entry===entry&&!entry.report&&!entry.error)entry.error=`Isolated comparison exited (${code}) without a report.`;clear();});
  this.timer=setTimeout(()=>{entry.error='Isolated comparison exceeded its ten-second limit.';void worker.terminate();},10000);this.timer.unref();worker.unref();return entry;
 }
 close():void {this.closed=true;this.entry=undefined;if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(this.worker)void this.worker.terminate();this.worker=undefined;}
}
