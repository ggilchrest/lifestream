import type {SleepSegment,SourceIdentity} from '@lifestream/contracts/mobile-context';
export type SleepEvidence={recordId:string;source:SourceIdentity;record:SleepSegment};
type Span={start:number;end:number;stage:SleepSegment['stage']};
export type SleepSummary={algorithmVersion:'sleep-union/1';state:'unknown'|'recorded';sourceKey:string|null;selectionReason:'preferred'|'stableSourceOrder'|'noReadableRecords';alternateSources:string[];startAt:string;endAt:string;inBedMs:number|null;asleepMs:number|null;awakeMs:number|null;stageMs:Partial<Record<SleepSegment['stage'],number>>;gapMs:number|null;recordedAwakeEpisodes:number|null;lineage:string[];conflictingStages:boolean;limitations:string[]};
export const sleepSourceKey=(s:SourceIdentity)=>JSON.stringify([s.collector,s.namespace,s.originalApp??null,s.originalDevice??null]);
const asleep=new Set<SleepSegment['stage']>(['coreLight','deep','rem','asleepUnspecified']);
// Resolve contradictory same-source stages explicitly; preserve the conflict flag.
const priority:SleepSegment['stage'][]=['awake','deep','rem','coreLight','asleepUnspecified','unknown'];
function union(spans:Span[]){const sorted=spans.slice().sort((a,b)=>a.start-b.start||a.end-b.end),out:Array<{start:number;end:number}>=[];for(const s of sorted){const last=out.at(-1);if(last&&s.start<=last.end)last.end=Math.max(last.end,s.end);else out.push({start:s.start,end:s.end});}return out;}
const duration=(spans:Array<{start:number;end:number}>)=>spans.reduce((sum,s)=>sum+s.end-s.start,0);
/** Data-only derivation; callers must already enforce current source/use/retention scope. */
export function summarizeSleep(records:readonly SleepEvidence[],startAt:string,endAt:string,preferredSource?:string):SleepSummary{
 const start=Date.parse(startAt),end=Date.parse(endAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000)throw Error('mobile_query_window_invalid');
 const relevant=records.filter(e=>Date.parse(e.record.startAt)<end&&Date.parse(e.record.endAt)>start),sources=[...new Set(relevant.map(e=>sleepSourceKey(e.source)))].sort();
 if(!sources.length)return {algorithmVersion:'sleep-union/1',state:'unknown',sourceKey:null,selectionReason:'noReadableRecords',alternateSources:[],startAt,endAt,inBedMs:null,asleepMs:null,awakeMs:null,stageMs:{},gapMs:null,recordedAwakeEpisodes:null,lineage:[],conflictingStages:false,limitations:['No readable sleep records in this window; this does not establish zero sleep or denied access.']};
 const selected=preferredSource&&sources.includes(preferredSource)?preferredSource:sources[0]!,chosen=relevant.filter(e=>sleepSourceKey(e.source)===selected),spans=chosen.map(e=>({start:Math.max(start,Date.parse(e.record.startAt)),end:Math.min(end,Date.parse(e.record.endAt)),stage:e.record.stage}));
 const points=[...new Set(spans.flatMap(s=>[s.start,s.end]))].sort((a,b)=>a-b),timeline:Span[]=[],events=new Map<number,Array<{stage:SleepSegment['stage'];delta:number}>>(),counts=new Map<SleepSegment['stage'],number>();let conflicting=false;
 for(const span of spans)if(span.stage!=='inBed'){for(const[at,delta]of[[span.start,1],[span.end,-1]]as const){const list=events.get(at)??[];list.push({stage:span.stage,delta});events.set(at,list);}}
 for(let i=0;i<points.length-1;i++){const a=points[i]!,b=points[i+1]!;for(const event of events.get(a)??[])counts.set(event.stage,(counts.get(event.stage)??0)+event.delta);const active=priority.filter(stage=>(counts.get(stage)??0)>0);if(active.length>1)conflicting=true;const stage=active[0];if(stage)timeline.push({start:a,end:b,stage});}
 const stageMs:SleepSummary['stageMs']={};for(const span of timeline)stageMs[span.stage]=(stageMs[span.stage]??0)+span.end-span.start;
 const sleeping=union(timeline.filter(s=>asleep.has(s.stage))),awake=union(timeline.filter(s=>s.stage==='awake')),inBed=union(spans.filter(s=>s.stage==='inBed'));
 const observedStart=points[0]!,observedEnd=points.at(-1)!,covered=union(timeline);const gapMs=observedEnd-observedStart-duration(covered);
 const episodes=awake.filter(w=>sleeping.some(s=>s.end<=w.start)&&sleeping.some(s=>s.start>=w.end)).length;
 return {algorithmVersion:'sleep-union/1',state:'recorded',sourceKey:selected,selectionReason:selected===preferredSource?'preferred':'stableSourceOrder',alternateSources:sources.filter(s=>s!==selected),startAt,endAt,inBedMs:inBed.length?duration(inBed):null,asleepMs:sleeping.length?duration(sleeping):null,awakeMs:awake.length?duration(awake):null,stageMs,gapMs,recordedAwakeEpisodes:episodes,lineage:[...new Set(chosen.map(e=>e.recordId))].sort(),conflictingStages:conflicting,limitations:['Recorded stages are source classifications, not physiological certainty.','Awake episodes count recorded awake unions between recorded sleep; unobserved awakenings are unknown.',...(conflicting?['Conflicting same-source stages resolved by awake/deep/REM/core/unspecified/unknown priority.']:[])]};
}
/** Separate sessions using a disclosed 90-minute unrecorded gap; not a sleep-quality score. */
export function sleepSessions(records:readonly SleepEvidence[],startAt:string,endAt:string,preferredSource?:string):SleepSummary[]{
 const start=Date.parse(startAt),end=Date.parse(endAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000)throw Error('mobile_query_window_invalid');
 const eligible=records.filter(e=>Date.parse(e.record.startAt)<end&&Date.parse(e.record.endAt)>start),sources=[...new Set(eligible.map(e=>sleepSourceKey(e.source)))].sort(),selected=preferredSource&&sources.includes(preferredSource)?preferredSource:sources[0];const sorted=eligible.filter(e=>sleepSourceKey(e.source)===selected).slice().sort((a,b)=>Date.parse(a.record.startAt)-Date.parse(b.record.startAt));if(!sorted.length)return [summarizeSleep([],startAt,endAt,preferredSource)];
 const groups:Array<{start:number;end:number;records:SleepEvidence[]}>=[];for(const entry of sorted){const a=Math.max(start,Date.parse(entry.record.startAt)),b=Math.min(end,Date.parse(entry.record.endAt)),last=groups.at(-1);if(last&&a-last.end<90*60000){last.end=Math.max(last.end,b);last.records.push(entry);}else groups.push({start:a,end:b,records:[entry]});}
 return groups.map(g=>summarizeSleep(eligible,new Date(g.start).toISOString(),new Date(g.end).toISOString(),preferredSource));
}
