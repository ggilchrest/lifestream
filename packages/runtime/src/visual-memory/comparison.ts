import {types} from 'node:util';

/** Internal host projection only. No text classifier, storage contract or provider authority. */
export type AppearanceScope=Readonly<{assistantId:string;principalId:string;relationshipId:string;subjectRef:string}>;
type Appearance=Readonly<{scope:AppearanceScope;sourceFamily:string;sessionId:string;capturedAtMs:number;attribution:'verifiedBinding'|'userConfirmed'|'unknown';headVisibility:'usable'|'occluded'|'outOfFrame'|'unknown';hat:'present'|'notVisible'|'unknown';limitations:readonly string[]}>;
export type HistoricalAppearanceEpisode=Appearance&Readonly<{episodeId:string;episodeRevision:number;lifecycleRevision:number;lifecycle:'active'|'corrected'|'superseded'|'forgotten'|'expired'|'needsReview';retainedUntilMs:number}>;
export type CurrentAppearance=Appearance&Readonly<{observationId:string;freshUntilMs:number}>;
export type AppearanceComparisonInput=Readonly<{
  scope:AppearanceScope;nowMs:number;calendarTimeZone:string;
  relationshipAuthorized:boolean;visualHistoryAllowed:boolean;audiencePermits:boolean;subjectBindingCurrent:boolean;
  coverage:Readonly<{fromMs:number;toMs:number;complete:boolean;totalEpisodes:number;boundaryRevision:string}>;
  current:CurrentAppearance;episodes:readonly HistoricalAppearanceEpisode[];
}>;
export const appearanceComparisonPolicy=Object.freeze({revision:'appearance-history.v1',windowMs:30*24*60*60*1000,minimumSupport:3,minimumSessions:3,minimumDates:3,supportPercent:75,maxEpisodes:128,maxInputBytes:262144});
type Dependency=Readonly<{episodeId:string;episodeRevision:number;lifecycleRevision:number;sourceFamily:string;sessionId:string;capturedAtMs:number;retainedUntilMs:number;limitations:readonly string[]}>;
type Opportunity=Readonly<{classification:'support'|'contrary'|'unknown';date:string;sessionId:string;episodeIds:readonly string[];sourceFamilies:readonly string[]}>;
export type AppearanceComparison=Readonly<{
  status:'qualified'|'unavailable';reason:'qualified'|'invalid_input'|'capacity_exceeded'|'scope_unavailable'|'boundary_changed'|'incomplete_coverage'|'current_unavailable'|'insufficient_history'|'insufficient_support';
  policyRevision:string;scope:AppearanceScope|null;boundaryRevision:string|null;
  window:Readonly<{fromMs:number;toMs:number;calendarTimeZone:string}>|null;
  numerator:number;denominator:number;supportingSessions:number;supportingDates:number;
  opportunities:readonly Opportunity[];counterexamples:readonly string[];dependencies:readonly Dependency[];
  excluded:Readonly<{notRetained:number;unattributed:number;headUnusable:number;currentSource:number}>;
  current:CurrentAppearance|null;validAtMs:number|null;freshUntilMs:number|null;
  claimScope:'observedSessionsOnly';
}>;
type Guard={boundary:()=>boolean;lastNowMs:number;freshUntilMs:number;monotonicDeadline:number;retired:boolean;checking:boolean};
const guards=new WeakMap<AppearanceComparison,Guard>();
const scopeKeys=['assistantId','principalId','relationshipId','subjectRef'] as const;
const appearanceKeys=['scope','sourceFamily','sessionId','capturedAtMs','attribution','headVisibility','hat','limitations'] as const;
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const time=(value:unknown):value is number=>count(value)&&value<=8_640_000_000_000_000;
class ComparisonCapacityError extends Error {}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>|null {
  if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)return null;
  const result:Record<string,unknown>={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))return null;result[key]=descriptor.value;}
  return result;
}
function array(value:unknown,maximum:number):unknown[]|null {
  if(!value||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
  const length=Object.getOwnPropertyDescriptor(value,'length')?.value as unknown;
  if(count(length)&&length>maximum)throw new ComparisonCapacityError();
  if(!count(length)||Reflect.ownKeys(value).length!==length+1)return null;
  const result:unknown[]=[];for(let index=0;index<length;index++){const item=Object.getOwnPropertyDescriptor(value,String(index));if(!item||!Object.hasOwn(item,'value'))return null;result.push(item.value);}return result;
}
function scope(value:unknown):AppearanceScope|null {const data=record(value,scopeKeys);return data&&scopeKeys.every(key=>identifier(data[key]))?data as AppearanceScope:null;}
const sameScope=(left:AppearanceScope,right:AppearanceScope)=>scopeKeys.every(key=>left[key]===right[key]);
function appearance(data:Record<string,unknown>):Appearance|null {
  const owner=scope(data.scope),limitations=array(data.limitations,8);
  if(!owner||!identifier(data.sourceFamily)||!identifier(data.sessionId)||!time(data.capturedAtMs)||typeof data.attribution!=='string'||!['verifiedBinding','userConfirmed','unknown'].includes(data.attribution)||typeof data.headVisibility!=='string'||!['usable','occluded','outOfFrame','unknown'].includes(data.headVisibility)||typeof data.hat!=='string'||!['present','notVisible','unknown'].includes(data.hat)||!limitations||limitations.some(item=>typeof item!=='string'||!item.trim()||Buffer.byteLength(item)>512))return null;
  return {scope:owner,sourceFamily:data.sourceFamily,sessionId:data.sessionId,capturedAtMs:data.capturedAtMs,attribution:data.attribution as Appearance['attribution'],headVisibility:data.headVisibility as Appearance['headVisibility'],hat:data.hat as Appearance['hat'],limitations:limitations as string[]};
}
function snapshot(value:unknown):AppearanceComparisonInput|null {
  const data=record(value,['scope','nowMs','calendarTimeZone','relationshipAuthorized','visualHistoryAllowed','audiencePermits','subjectBindingCurrent','coverage','current','episodes']);if(!data)return null;
  const owner=scope(data.scope),coverage=record(data.coverage,['fromMs','toMs','complete','totalEpisodes','boundaryRevision']),currentData=record(data.current,[...appearanceKeys,'observationId','freshUntilMs']),rows=array(data.episodes,appearanceComparisonPolicy.maxEpisodes);
  if(!owner||!time(data.nowMs)||typeof data.calendarTimeZone!=='string'||data.calendarTimeZone.length>100||!['relationshipAuthorized','visualHistoryAllowed','audiencePermits','subjectBindingCurrent'].every(key=>typeof data[key]==='boolean')||!coverage||!time(coverage.fromMs)||!time(coverage.toMs)||typeof coverage.complete!=='boolean'||!count(coverage.totalEpisodes)||!identifier(coverage.boundaryRevision)||!currentData||!identifier(currentData.observationId)||!time(currentData.freshUntilMs)||!rows)return null;
  const current=appearance(currentData);if(!current)return null;
  const episodes:HistoricalAppearanceEpisode[]=[];
  for(const row of rows){
    const item=record(row,[...appearanceKeys,'episodeId','episodeRevision','lifecycleRevision','lifecycle','retainedUntilMs']);if(!item)return null;
    const projected=appearance(item);
    if(!projected||!identifier(item.episodeId)||!count(item.episodeRevision)||!count(item.lifecycleRevision)||!time(item.retainedUntilMs)||typeof item.lifecycle!=='string'||!['active','corrected','superseded','forgotten','expired','needsReview'].includes(item.lifecycle))return null;
    episodes.push({...projected,episodeId:item.episodeId,episodeRevision:item.episodeRevision,lifecycleRevision:item.lifecycleRevision,lifecycle:item.lifecycle as HistoricalAppearanceEpisode['lifecycle'],retainedUntilMs:item.retainedUntilMs});
  }
  const copied:AppearanceComparisonInput={scope:owner,nowMs:data.nowMs,calendarTimeZone:data.calendarTimeZone,relationshipAuthorized:data.relationshipAuthorized as boolean,visualHistoryAllowed:data.visualHistoryAllowed as boolean,audiencePermits:data.audiencePermits as boolean,subjectBindingCurrent:data.subjectBindingCurrent as boolean,coverage:{fromMs:coverage.fromMs,toMs:coverage.toMs,complete:coverage.complete,totalEpisodes:coverage.totalEpisodes,boundaryRevision:coverage.boundaryRevision},current:{...current,observationId:currentData.observationId,freshUntilMs:currentData.freshUntilMs},episodes};
  if(Buffer.byteLength(JSON.stringify(copied))>appearanceComparisonPolicy.maxInputBytes)throw new ComparisonCapacityError();
  return copied;
}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const currentBoundary=(current:()=>boolean):boolean=>{try{return current()===true;}catch{return false;}};
function unavailable(reason:AppearanceComparison['reason']):AppearanceComparison {
  return freeze({status:'unavailable',reason,policyRevision:appearanceComparisonPolicy.revision,scope:null,boundaryRevision:null,window:null,numerator:0,denominator:0,supportingSessions:0,supportingDates:0,opportunities:[],counterexamples:[],dependencies:[],excluded:{notRetained:0,unattributed:0,headUnusable:0,currentSource:0},current:null,validAtMs:null,freshUntilMs:null,claimScope:'observedSessionsOnly'});
}

/** The host supplies an exhaustive bounded window at one authorized lifecycle
 * revision. The callback must cover permissions, subject binding and every
 * source/tombstone change. A top-k recall result cannot assert complete coverage.
 * Classification is supplied explicitly; no prose is interpreted here. */
export function compareHistoricalAppearance(value:AppearanceComparisonInput,boundaryCurrent:(revision:string)=>boolean):AppearanceComparison {
  const startedMono=performance.now();
  let input:AppearanceComparisonInput|null;
  try{input=snapshot(value);}catch(error){return unavailable(error instanceof ComparisonCapacityError?'capacity_exceeded':'invalid_input');}
  if(!input)return unavailable('invalid_input');
  const {scope:owner,current,coverage,nowMs}=input;
  if(!input.relationshipAuthorized||!input.visualHistoryAllowed||!input.audiencePermits||!input.subjectBindingCurrent||!sameScope(owner,current.scope)||input.episodes.some(item=>!sameScope(owner,item.scope)))return unavailable('scope_unavailable');
  const boundary=()=>boundaryCurrent(coverage.boundaryRevision);
  if(!currentBoundary(boundary))return unavailable('boundary_changed');
  let calendar:Intl.DateTimeFormat;
  try{calendar=new Intl.DateTimeFormat('en-CA',{timeZone:input.calendarTimeZone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{return unavailable('invalid_input');}
  if(!coverage.complete||coverage.totalEpisodes!==input.episodes.length||coverage.fromMs!==nowMs-appearanceComparisonPolicy.windowMs||coverage.toMs!==nowMs)return unavailable('incomplete_coverage');
  if(current.attribution==='unknown'||current.headVisibility!=='usable'||current.hat!=='notVisible'||current.capturedAtMs>nowMs||current.freshUntilMs<=nowMs||current.freshUntilMs>current.capturedAtMs+6000)return unavailable('current_unavailable');
  if(new Set(input.episodes.map(item=>item.episodeId)).size!==input.episodes.length||input.episodes.some(item=>item.capturedAtMs<coverage.fromMs||item.capturedAtMs>=coverage.toMs||item.retainedUntilMs<=item.capturedAtMs))return unavailable('invalid_input');
  // Original identity metadata constrains independence even when its content is
  // no longer eligible. Discarding an inactive/unattributed bridge first could
  // turn correlated copies into independent support. Such rows never vote or
  // enter result dependencies, and no erased description is needed here.
  const groups:HistoricalAppearanceEpisode[][]=[];
  for(const item of input.episodes){
    const linked=groups.filter(group=>group.some(other=>other.sourceFamily===item.sourceFamily||other.sessionId===item.sessionId));
    if(!linked.length)groups.push([item]);else{const merged=[item,...linked.flat()];for(const group of linked)groups.splice(groups.indexOf(group),1);groups.push(merged);}
  }
  const currentCorrelated=new Set(groups.filter(group=>group.some(item=>item.sessionId===current.sessionId||item.sourceFamily===current.sourceFamily||item.capturedAtMs>=current.capturedAtMs)).flat());
  const excluded={notRetained:0,unattributed:0,headUnusable:0,currentSource:0},eligible:HistoricalAppearanceEpisode[]=[],dependencies:Dependency[]=[];
  let freshUntilMs=current.freshUntilMs;
  for(const item of input.episodes){
    if(item.lifecycle!=='active'||item.retainedUntilMs<=nowMs){excluded.notRetained++;continue;}
    if(item.attribution==='unknown'){excluded.unattributed++;continue;}
    if(currentCorrelated.has(item)){excluded.currentSource++;continue;}
    const {episodeId,episodeRevision,lifecycleRevision,sourceFamily,sessionId,capturedAtMs,retainedUntilMs,limitations}=item;
    dependencies.push({episodeId,episodeRevision,lifecycleRevision,sourceFamily,sessionId,capturedAtMs,retainedUntilMs,limitations});
    freshUntilMs=Math.min(freshUntilMs,retainedUntilMs);
    if(item.headVisibility!=='usable')excluded.headUnusable++;
    eligible.push(item);
  }
  // Only retained, attributable, usable-head content classifies an opportunity;
  // contrary/unknown members cannot be hidden by supporting duplicates.
  const voters=new Set(eligible.filter(item=>item.headVisibility==='usable'));
  const opportunities:Opportunity[]=groups.filter(group=>group.some(item=>voters.has(item))).map(members=>{
    const group=members.filter(item=>voters.has(item));
    group.sort((a,b)=>a.capturedAtMs-b.capturedAtMs||a.episodeId.localeCompare(b.episodeId));
    const first=group[0]!,classification=group.some(item=>item.hat==='notVisible')?'contrary':group.some(item=>item.hat==='unknown')?'unknown':'support';
    // One conservative original date/session per group, selected together.
    const parts=calendar.formatToParts(first.capturedAtMs),date=['year','month','day'].map(key=>parts.find(part=>part.type===key)!.value).join('-');
    return {classification,date,sessionId:first.sessionId,episodeIds:group.map(item=>item.episodeId),sourceFamilies:[...new Set(group.map(item=>item.sourceFamily))]};
  });
  const supporting=opportunities.filter(item=>item.classification==='support'),numerator=supporting.length,denominator=opportunities.length;
  const supportingSessions=new Set(supporting.map(item=>item.sessionId)).size,supportingDates=new Set(supporting.map(item=>item.date)).size;
  const enough=numerator>=appearanceComparisonPolicy.minimumSupport&&supportingSessions>=appearanceComparisonPolicy.minimumSessions&&supportingDates>=appearanceComparisonPolicy.minimumDates;
  const supported=denominator>0&&numerator*100>=denominator*appearanceComparisonPolicy.supportPercent;
  if(!currentBoundary(boundary))return unavailable('boundary_changed');
  const monotonicDeadline=startedMono+freshUntilMs-nowMs;
  if(performance.now()>=monotonicDeadline)return unavailable('current_unavailable');
  const result:AppearanceComparison=freeze({status:enough&&supported?'qualified':'unavailable',reason:!enough?'insufficient_history':!supported?'insufficient_support':'qualified',policyRevision:appearanceComparisonPolicy.revision,scope:owner,boundaryRevision:coverage.boundaryRevision,window:{fromMs:coverage.fromMs,toMs:coverage.toMs,calendarTimeZone:input.calendarTimeZone},numerator,denominator,supportingSessions,supportingDates,opportunities,counterexamples:eligible.filter(item=>item.headVisibility==='usable'&&item.hat==='notVisible').map(item=>item.episodeId),dependencies,excluded,current,validAtMs:nowMs,freshUntilMs,claimScope:'observedSessionsOnly'});
  if(result.status==='qualified')guards.set(result,{boundary,lastNowMs:nowMs,freshUntilMs,monotonicDeadline,retired:false,checking:false});
  return result;
}

/** Recheck the authentic result before use; correction/revocation/expiry retires
 * it permanently. This does not extend capture freshness or retained-source life. */
export function appearanceComparisonCurrent(result:AppearanceComparison,nowMs:number):boolean {
  const guard=guards.get(result);if(!guard||guard.retired)return false;
  if(guard.checking){guard.retired=true;return false;}
  guard.checking=true;
  try {
    if(!time(nowMs)||nowMs<guard.lastNowMs||nowMs>=guard.freshUntilMs||performance.now()>=guard.monotonicDeadline||!currentBoundary(guard.boundary)||guard.retired||performance.now()>=guard.monotonicDeadline){guard.retired=true;return false;}
    guard.lastNowMs=nowMs;return true;
  } finally {guard.checking=false;}
}
