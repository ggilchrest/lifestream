import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
type Purpose='play'|'contact';type Windows=G.GamePolicy['schedule']['windows'];
export type GameWindowInput={scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds;purpose:Purpose;nowMs:number};
export type GameWindowBoundary={policyCurrent:(scope:G.ActivityScope,policy:G.GamePolicy,bounds:G.GameBounds)=>boolean;now?:()=>number};
export type GameWindowSelection=Readonly<{status:'inside'|'outside'|'unavailable';reason:'inside'|'outside'|'disabled'|'invalidInput'|'invalidWindows'|'policyUnavailable';purpose:Purpose;policyRevision:number|null;windowId:string|null;localDate:string|null;occurrenceKey:string|null;authority:false;isCurrent:()=>boolean}>;
const known=new WeakMap<GameWindowSelection,{scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds;current:()=>boolean}>();
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function windowsValid(windows:Windows):boolean{
 if(new Set(windows.map(w=>w.windowId)).size!==windows.length||windows.some(w=>w.startMinute>=w.endMinute))return false;
 const days=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
 for(const day of days){const sorted=windows.filter(w=>w.daysOfWeek.includes(day as Windows[number]['daysOfWeek'][number])).sort((a,b)=>a.startMinute-b.startMinute);for(let i=1;i<sorted.length;i++)if(sorted[i]!.startMinute<sorted[i-1]!.endMinute)return false;}
 return true;
}
/** Calendar match only. This enrolls no schedule, reserves no start, creates no
 * replacement run and grants no controller/contact/delivery permission. */
export function selectGameWindow(raw:GameWindowInput,boundary:GameWindowBoundary):GameWindowSelection {
 const input=boundedGameDataSnapshot(raw) as GameWindowInput|null,purpose=input?.purpose==='contact'?'contact':'play';
 const no=(reason:GameWindowSelection['reason'],status:GameWindowSelection['status']='unavailable'):GameWindowSelection=>freeze({status,reason,purpose,policyRevision:Number.isSafeInteger(input?.policy?.revision)?input!.policy.revision:null,windowId:null,localDate:null,occurrenceKey:null,authority:false,isCurrent:()=>false});
 if(!input||Object.keys(input).sort().join(',')!=='bounds,nowMs,policy,purpose,scope'||!['play','contact'].includes(input.purpose)||!Number.isSafeInteger(input.nowMs)||input.nowMs<0||!Number.isFinite(new Date(input.nowMs).getTime())||!validator.validate(schema+'ActivityScope',input.scope).valid||!validator.validate(schema+'GamePolicy',input.policy).valid||!validator.validate(schema+'GameBounds',input.bounds).valid)return no('invalidInput');
 freeze(input);const config=input.purpose==='play'?input.policy.schedule:input.policy.contactConfiguration;
 if(!config.enabled)return no('disabled');
 if(config.validatedPolicyRevision!==input.policy.revision||config.validatedAt===null||Date.parse(config.validatedAt)>input.nowMs||config.policyCurrent!==true||config.unavailableReason!==null)return no('policyUnavailable');
 if(!windowsValid(config.windows))return no('invalidWindows');
 let calendar:Intl.DateTimeFormat;
 // Modern Intl accepts numeric UTC offsets; configured policy requires an IANA
 // zone (including supported aliases), not an offset silently standing in for it.
 try{if(!config.timeZone||/^[+-]/u.test(config.timeZone))throw 0;calendar=new Intl.DateTimeFormat('en-US',{timeZone:config.timeZone,calendar:'iso8601',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(/^[+-]/u.test(calendar.resolvedOptions().timeZone))throw 0;}catch{return no('invalidWindows');}
 const local=(now:number)=>{const parts=Object.fromEntries(calendar.formatToParts(now).map(p=>[p.type,p.value])),day=parts.weekday!.toLowerCase() as Windows[number]['daysOfWeek'][number],minute=Number(parts.hour)*60+Number(parts.minute),date=`${parts.year}-${parts.month}-${parts.day}`;return {date,window:config.windows.find(w=>w.daysOfWeek.includes(day)&&minute>=w.startMinute&&minute<w.endMinute)};};
 let retired=false,checking=false,lastNow=input.nowMs;
 const policyCurrent=()=>{try{return boundary.policyCurrent(input.scope,input.policy,input.bounds)===true;}catch{return false;}};
 if(!policyCurrent())return no('policyUnavailable');const selected=local(input.nowMs);if(!selected.window)return no('outside','outside');
 const clock=boundary.now??Date.now,windowId=selected.window.windowId,date=selected.date;
 const current=()=>{if(retired||checking){retired=true;return false;}checking=true;try{const now=clock();if(!Number.isSafeInteger(now)||now<lastNow||!Number.isFinite(new Date(now).getTime())||!policyCurrent()){retired=true;return false;}const after=clock(),instant=local(after);if(!Number.isSafeInteger(after)||after<now||instant.date!==date||instant.window?.windowId!==windowId||!policyCurrent()){retired=true;return false;}lastNow=after;return true;}catch{retired=true;return false;}finally{checking=false;}};
 if(!current())return no('policyUnavailable');
 // No run/epoch/UTC offset enters the occurrence identity. A repeated local
 // window during DST fall-back is one occurrence, not another start/contact.
 const selection:GameWindowSelection=freeze({status:'inside',reason:'inside',purpose:input.purpose,policyRevision:input.policy.revision,windowId,localDate:date,occurrenceKey:hash([input.scope.assistantId,input.scope.principalId,input.scope.relationshipId,input.scope.environmentId,input.scope.activityId,input.purpose,input.policy.revision,config.timeZone,date,windowId]),authority:false,isCurrent:current});known.set(selection,{scope:input.scope,policy:input.policy,bounds:input.bounds,current});return selection;
}
/** Authentic temporal selection is still only one input to separate current
 * lifecycle/capability/contact admission. Clones cannot donate its callback. */
export function gameWindowCurrent(selection:GameWindowSelection,scope:Pick<G.ActivityScope,'assistantId'|'principalId'|'relationshipId'|'environmentId'|'activityId'>,configuration?:{policy:G.GamePolicy;bounds:G.GameBounds}):boolean{
 const entry=known.get(selection),snapshot=boundedGameDataSnapshot(scope) as typeof scope|null;if(!entry||!snapshot||Object.keys(snapshot).sort().join(',')!=='activityId,assistantId,environmentId,principalId,relationshipId'&&!validator.validate(schema+'ActivityScope',snapshot).valid)return false;
 if(configuration!==undefined){const config=boundedGameDataSnapshot(configuration) as typeof configuration|null;if(!config||Object.keys(config).sort().join(',')!=='bounds,policy'||!isDeepStrictEqual(config.policy,entry.policy)||!isDeepStrictEqual(config.bounds,entry.bounds))return false;}
 return (['assistantId','principalId','relationshipId','environmentId','activityId'] as const).every(k=>snapshot[k]===entry.scope[k])&&entry.current();
}
