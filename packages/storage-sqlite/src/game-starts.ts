import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {Database} from './database.ts';
export type GameStartOccurrence={scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds;windowId:string;localDate:string;occurrenceKey:string};
export type GameStartLimits={enabled:boolean;revision:number;rollingPeriodMs:number;rollingStartLimit:number;startsPerWindow:number};
type Disposition='claimed'|'paused'|'recoveryRequired'|'stopped'|'completed';
type Row={run_id:string;assistant_id:string;scope_digest:string;owner_key:string;occurrence_key:string;calendar_key:string;policy_digest:string;claimed_at:number;revision:number;disposition:Disposition;receipt_digest:string|null};
export type GameStartOptions={
 maxClaims:number;maxAssistantSlots:number;
 quarantined:()=>boolean;
 limitsFor:(input:GameStartOccurrence)=>GameStartLimits|null;
 /** Actual registered policy, current hours, runtime enrollment, source/display,
  * authority, takeover/old-run resolution and all remaining resource budgets. */
 admissionCurrent:(input:GameStartOccurrence,limits:GameStartLimits)=>boolean;
 inspectionCurrent:(scope:G.ActivityScope)=>boolean;
 /** Independently qualified exact-old-run pause/terminal evidence. A callback
  * returning true is trusted host truth, never model or schema self-certification. */
 dispositionCurrent:(scope:G.ActivityScope,next:Exclude<Disposition,'claimed'>,revision:number,receiptRef:string)=>boolean;
 now?:()=>number;
};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const positive=(n:unknown,max=2147483647):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=max;
const checked=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const unavailable=()=>new Error('Game start metadata is unavailable');
/** Claiming consumes a durable start identity conservatively before any effect.
 * It launches nothing. Unknown/paused claims retain the Assistant's blocking
 * slot across restart; there is no refund, retry, replay or automatic resume. */
export class GameStartRepository {
 private readonly database:Database;private readonly options:GameStartOptions;private readonly capacity:Readonly<{claims:number;slots:number}>;
 constructor(database:Database,options:GameStartOptions){if(!positive(options.maxClaims,8192)||!positive(options.maxAssistantSlots,128))throw unavailable();this.database=database;this.options=options;this.capacity=Object.freeze({claims:options.maxClaims,slots:options.maxAssistantSlots});}
 private time(){const now=(this.options.now??Date.now)(),floor=this.database.connection.prepare('SELECT observed_at FROM activity_metadata_clock WHERE singleton=1').get()!.observed_at as number;if(!Number.isSafeInteger(now)||now<floor||!Number.isFinite(new Date(now).getTime()))throw unavailable();this.database.connection.prepare('UPDATE activity_metadata_clock SET observed_at=? WHERE singleton=1').run(now);return now;}
 private scope(raw:G.ActivityScope){const scope=boundedGameDataSnapshot(raw) as G.ActivityScope|null;if(!scope||!validator.validate(schema+'ActivityScope',scope).valid)throw unavailable();return freeze(scope);}
 private limits(input:GameStartOccurrence){const limits=boundedGameDataSnapshot(this.options.limitsFor(input)) as GameStartLimits|null;if(!limits||Object.keys(limits).sort().join(',')!=='enabled,revision,rollingPeriodMs,rollingStartLimit,startsPerWindow'||limits.enabled!==true||limits.revision!==input.policy.revision||!positive(limits.rollingPeriodMs)||!positive(limits.rollingStartLimit)||!positive(limits.startsPerWindow))throw unavailable();return freeze(limits);}
 private current(input:GameStartOccurrence,limits:GameStartLimits,currentWindow:()=>boolean){return checked(()=>this.options.quarantined()===false&&currentWindow()===true&&this.options.admissionCurrent(input,limits)===true&&isDeepStrictEqual(this.limits(input),limits)&&currentWindow()===true&&this.options.quarantined()===false);}
 claim(raw:GameStartOccurrence,currentWindow:()=>boolean):boolean {
  const input=boundedGameDataSnapshot(raw) as GameStartOccurrence|null;if(!input||Object.keys(input).sort().join(',')!=='bounds,localDate,occurrenceKey,policy,scope,windowId'||!validator.validate(schema+'ActivityScope',input.scope).valid||!validator.validate(schema+'GamePolicy',input.policy).valid||!validator.validate(schema+'GameBounds',input.bounds).valid||!/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)||!input.policy.schedule.enabled||input.policy.schedule.validatedPolicyRevision!==input.policy.revision||!input.policy.schedule.windows.some(w=>w.windowId===input.windowId))throw unavailable();
  freeze(input);const s=input.scope,parts=[s.assistantId,s.principalId,s.relationshipId,s.environmentId,s.activityId,'play'],calendar=[input.policy.schedule.timeZone,input.localDate,input.windowId];
  if(input.occurrenceKey!==hash([...parts,input.policy.revision,...calendar]))throw unavailable();
  const now=this.time(),limits=this.limits(input),calendarKey=hash([...parts,...calendar]);if(!this.current(input,limits,currentWindow))return false;
  return this.database.transaction(tx=>{
   if(tx.get('SELECT run_id FROM game_start_claims WHERE run_id=? OR occurrence_key=? OR calendar_key=?',s.runId,input.occurrenceKey,calendarKey)||tx.get('SELECT run_id FROM game_controller_slots WHERE assistant_id=?',s.assistantId))return false;
   if(tx.get<{n:number}>('SELECT count(*) AS n FROM game_start_claims')!.n>=this.capacity.claims||tx.get<{n:number}>('SELECT count(*) AS n FROM game_controller_slots')!.n>=this.capacity.slots)throw unavailable();
   // All prior claims, including unknown/failed starts, count across activity,
   // owner/environment/policy changes. A new configuration cannot reset usage.
   if(tx.get<{n:number}>('SELECT count(*) AS n FROM game_start_claims WHERE assistant_id=? AND claimed_at>?',s.assistantId,now-limits.rollingPeriodMs)!.n>=limits.rollingStartLimit)return false;
   if(!this.current(input,limits,currentWindow))return false;
   tx.run("INSERT INTO game_start_claims VALUES(?,?,?,?,?,?,?,?,1,'claimed',NULL)",s.runId,s.assistantId,hash(s),hash(parts),input.occurrenceKey,calendarKey,hash([input.policy,input.bounds,limits]),now);
   tx.run('INSERT INTO game_controller_slots VALUES(?,?)',s.assistantId,s.runId);
   if(!this.current(input,limits,currentWindow)||this.time()<now||!this.current(input,limits,currentWindow))throw unavailable();return true;
  });
 }
 inspect(raw:G.ActivityScope){const scope=this.scope(raw);this.time();const current=()=>checked(()=>this.options.quarantined()===false&&this.options.inspectionCurrent(scope)&&this.options.quarantined()===false);if(!current())return null;const row=this.database.connection.prepare('SELECT * FROM game_start_claims WHERE run_id=? AND scope_digest=?').get(scope.runId,hash(scope)) as Row|undefined;if(!row||!current())return null;return Object.freeze({runId:scope.runId,revision:row.revision,recordedDisposition:row.disposition,claimedAt:new Date(row.claimed_at).toISOString(),blocksReplacement:!['stopped','completed'].includes(row.disposition),continuationAuthority:false as const});}
 /** Paused/recovery dispositions retain ownership. Only qualified actual
  * terminal evidence releases the exact original slot; never a successor. */
 noteDisposition(raw:G.ActivityScope,next:Exclude<Disposition,'claimed'>,expectedRevision:number,receiptRef:string):boolean {
  const scope=this.scope(raw);this.time();if(!['paused','recoveryRequired','stopped','completed'].includes(next)||!positive(expectedRevision)||typeof receiptRef!=='string'||!receiptRef.trim()||Buffer.byteLength(receiptRef)>2048)return false;
  const current=()=>checked(()=>this.options.inspectionCurrent(scope)&&this.options.dispositionCurrent(scope,next,expectedRevision,receiptRef)&&this.options.inspectionCurrent(scope));if(!current())return false;
  return this.database.transaction(tx=>{const row=tx.get<Row>('SELECT * FROM game_start_claims WHERE run_id=? AND scope_digest=?',scope.runId,hash(scope));if(!row||row.revision!==expectedRevision||['stopped','completed'].includes(row.disposition))return false;if(!current())return false;tx.run('UPDATE game_start_claims SET disposition=?,revision=revision+1,receipt_digest=? WHERE run_id=? AND revision=?',next,hash(receiptRef),scope.runId,expectedRevision);if(next==='stopped'||next==='completed')tx.run('DELETE FROM game_controller_slots WHERE assistant_id=? AND run_id=?',scope.assistantId,scope.runId);if(!current())throw unavailable();this.time();if(!current())throw unavailable();return true;});
 }
}
