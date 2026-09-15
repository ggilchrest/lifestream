import { createHash, randomUUID } from "node:crypto";
import { createContractValidator } from "@lifestream/contracts";
import type { Database, Transaction } from "./database.ts";

export type InitiativeScope = { assistantId: string; userId: string; relationshipId: string; deploymentId: string };
export type InitiativeOpportunity = InitiativeScope & {
  schemaVersion: "1.0.0"; recordType: "opportunity"; opportunityId: string; correlationId: string;
  conversationId: string; sessionId: string; endpointId: string; configurationId: string;
  configurationRevision: number; policyRevision: string;
  kind: "arrivalReturn" | "availableCheckIn" | "groundedFollowUp"; category: "social"; urgency: "low";
  sourceKind: "simulatedBrowser" | "qualifiedProvider" | "runtimeContext";
  sourceRefs: string[]; executionMode: "normal" | "simulation" | "replay";
  observedAt: string; receivedAt: string; expiresAt: string; dedupKey: string; topicKey: string;
};
type State = "pending" | "eligible" | "generated" | "queued" | "emitted" | "acknowledged" | "suppressed" | "expired" | "failed" | "cancelled" | "unknown";
type Stage = "none" | "generated" | "queued" | "emitted" | "acknowledged";
type Response = "notObserved" | "replied" | "dismissed" | "noResponse";
type Acknowledgment = "endpointAccepted" | "playbackCompleted";
export type InitiativeDeliveryOutcome = InitiativeScope & {
  schemaVersion: "1.0.0"; recordType: "outcome"; opportunityId: string; correlationId: string;
  configurationId: string; configurationRevision: number; policyRevision: string;
  state: State; occurredAt: string; reasonCodes: string[]; sourceRefs: string[];
  preparedViewId: string | null; interactionId: string | null; lastDeliveryStage: Stage;
  deliveryReceiptRef: string | null; acknowledgmentKind: Acknowledgment | null; response: Response;
};
export type InitiativeDeliveryRecord = { opportunity: InitiativeOpportunity; outcome: InitiativeDeliveryOutcome; version: number; budget: "none" | "held" | "charged" | "released" };
export type InitiativeOpeningLimits = { perHour: number; perDay: number; minimumGapMs: number };
export type InitiativeInferenceLimits = { perRelationshipHour: number; perRuntimeHour: number };
export type InitiativeInferenceUsage = { relationshipHour: number; runtimeHour: number; active: boolean };
/** These are host calls, never request bodies. The current callback must synchronously
 * recheck current scope, consent/configuration, source, endpoint and lease ownership. */
export type InitiativeDeliveryAction =
  | { type: "eligible" }
  | { type: "generated"; preparedViewId: string; interactionId: string }
  | { type: "queue"; limits: InitiativeOpeningLimits; current: (tx: Transaction) => boolean }
  | { type: "beginEmission"; receiptId: string; current: (tx: Transaction) => boolean }
  | { type: "emitted"; receiptId: string }
  | { type: "acknowledge"; sessionId: string; receiptId: string; kind: Acknowledgment }
  | { type: "finish"; state: "suppressed" | "expired" | "failed" | "cancelled" | "unknown"; reasons: string[] }
  | { type: "respond"; sessionId: string; response: Exclude<Response,"notObserved"> };
type Row = { opportunity_json: string; outcome_json: string; version: number; budget_state: InitiativeDeliveryRecord["budget"]; emission_started: number; receipt_id: string | null; reserved_ms: number | null; updated_ms: number };
const validator = createContractValidator();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeKey = (scope: InitiativeScope) => digest([scope.assistantId,scope.userId,scope.relationshipId,scope.deploymentId]);
const active = "('pending','eligible','generated','queued','emitted')";
const terminal = new Set<State>(["acknowledged","suppressed","expired","failed","cancelled","unknown"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function validate(value: unknown, definition: string): void {
  if(!validator.validate(`https://lifestream.dev/contracts/relational-initiative/1.0.0#/$defs/${definition}`,value).valid)throw new Error("Invalid Initiative record");
}
const decode = (row: Row): InitiativeDeliveryRecord => ({opportunity:JSON.parse(row.opportunity_json),outcome:JSON.parse(row.outcome_json),version:row.version,budget:row.budget_state});

/** Owner-local accounting for the approved v1 records. No output payloads, provider
 * calls, permission inference, retries or separate conversation/memory lifecycle. */
export class InitiativeDeliveryRepository {
  private readonly database: Database;
  private readonly now: () => number;
  constructor(database: Database, now: () => number = Date.now) {this.database=database;this.now=now;}
  private clock(tx: Transaction): number {
    const time=this.now(),last=tx.get<{last_ms:number}>("SELECT last_ms FROM initiative_clock WHERE singleton=1")?.last_ms;
    if(!Number.isSafeInteger(time)||time<0||(last!==undefined&&time<last))throw new Error("Initiative clock discontinuity");
    tx.run("INSERT INTO initiative_clock VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET last_ms=excluded.last_ms",time);
    return time;
  }
  private row(tx: Transaction,scope: InitiativeScope,id: string): Row {
    const row=tx.get<Row>("SELECT * FROM initiative_delivery WHERE opportunity_id=? AND scope_key=?",id,scopeKey(scope));
    if(!row)throw new Error("Unknown Initiative opportunity");return row;
  }
  get(scope: InitiativeScope,id: string): InitiativeDeliveryRecord | undefined {
    const row=this.database.connection.prepare("SELECT * FROM initiative_delivery WHERE opportunity_id=? AND scope_key=?").get(id,scopeKey(scope)) as Row|undefined;
    return row?decode(row):undefined;
  }
  list(scope: InitiativeScope): InitiativeDeliveryRecord[] {
    return (this.database.connection.prepare("SELECT * FROM initiative_delivery WHERE scope_key=? ORDER BY updated_ms DESC,opportunity_id LIMIT 64").all(scopeKey(scope)) as Row[]).map(decode);
  }
  private inferenceCounts(tx:Transaction,scope:InitiativeScope,now:number):InitiativeInferenceUsage {
    const relationshipHour=tx.get<{n:number}>("SELECT count(*) AS n FROM initiative_inference_calls WHERE scope_key=? AND started_ms>?",scopeKey(scope),now-3_600_000)!.n;
    const runtimeHour=tx.get<{n:number}>("SELECT count(*) AS n FROM initiative_inference_calls WHERE started_ms>?",now-3_600_000)!.n;
    const busy=tx.get("SELECT 1 FROM initiative_inference_calls WHERE settled_ms IS NULL");
    return {relationshipHour,runtimeHour,active:!!busy};
  }
  inferenceUsage(scope:InitiativeScope):InitiativeInferenceUsage {
    return this.database.transaction(tx=>this.inferenceCounts(tx,scope,this.clock(tx)));
  }
  /** Persist before the only provider call. A reservation is never refunded: an
   * uncertain crash between this commit and provider invocation must not permit retry.
   * current includes the host's ordinary-turn priority and current policy fences. */
  reserveInference(scope:InitiativeScope,id:string,expectedVersion:number,limits:InitiativeInferenceLimits,current:(tx:Transaction)=>boolean):string {
    if(!Number.isInteger(limits.perRelationshipHour)||limits.perRelationshipHour<0||limits.perRelationshipHour>24||!Number.isInteger(limits.perRuntimeHour)||limits.perRuntimeHour<0||limits.perRuntimeHour>48)throw new Error("Invalid Initiative inference limits");
    return this.database.transaction(tx=>{
      const row=this.row(tx,scope,id),{opportunity,outcome}=decode(row),now=this.clock(tx);
      if(row.version!==expectedVersion)throw new Error("Initiative revision conflict");
      if(outcome.state!=="eligible"||opportunity.executionMode==="replay")throw new Error("Invalid Initiative inference admission");
      if(Date.parse(opportunity.expiresAt)<=now)throw new Error("Initiative opportunity expired");
      if(current(tx)!==true)throw new Error("Initiative boundary changed");
      if(tx.get("SELECT 1 FROM initiative_inference_calls WHERE opportunity_id=?",id))throw new Error("Initiative inference already reserved");
      const usage=this.inferenceCounts(tx,scope,now);
      if(usage.active)throw new Error("Initiative inference is occupied");
      if(usage.relationshipHour>=limits.perRelationshipHour||usage.runtimeHour>=limits.perRuntimeHour)throw new Error("Initiative inference budget exhausted");
      const claimId=randomUUID();
      tx.run("INSERT INTO initiative_inference_calls (opportunity_id,scope_key,claim_id,started_ms) VALUES (?,?,?,?)",id,scopeKey(scope),claimId,now);
      return claimId;
    });
  }
  /** Only the actual provider iterator's settlement releases the runtime slot.
   * Cancelling/expiring an opportunity alone cannot free an unsettled call. */
  settleInference(scope:InitiativeScope,id:string,claimId:string):void {
    this.database.transaction(tx=>{
      const now=this.clock(tx),call=tx.get<{settled_ms:number|null}>("SELECT settled_ms FROM initiative_inference_calls WHERE opportunity_id=? AND scope_key=? AND claim_id=?",id,scopeKey(scope),claimId);
      if(!call)throw new Error("Invalid Initiative inference claim");
      if(call.settled_ms===null)tx.run("UPDATE initiative_inference_calls SET settled_ms=? WHERE opportunity_id=? AND claim_id=? AND settled_ms IS NULL",now,id,claimId);
    });
  }
  /** Admission is after host qualification. Identity strings in a record are not authority.
   * Strict source watermarks intentionally coalesce simultaneous/out-of-order events. */
  admit(scope: InitiativeScope,opportunity: InitiativeOpportunity,current: (tx: Transaction)=>boolean,limits={perRelationship:4,perRuntime:16}): InitiativeDeliveryRecord {
    validate(opportunity,"RelationalOpportunity");
    if(scopeKey(scope)!==scopeKey(opportunity))throw new Error("Invalid Initiative scope");
    if(!Number.isInteger(limits.perRelationship)||limits.perRelationship<1||limits.perRelationship>8||!Number.isInteger(limits.perRuntime)||limits.perRuntime<1||limits.perRuntime>32)throw new Error("Invalid Initiative queue limits");
    return this.database.transaction(tx=>{
      const now=this.clock(tx),key=scopeKey(scope),observed=Date.parse(opportunity.observedAt),received=Date.parse(opportunity.receivedAt),expires=Date.parse(opportunity.expiresAt);
      if(current(tx)!==true)throw new Error("Initiative boundary changed");
      if(observed>received||received>now||expires<=now||expires>observed+600_000||expires<=observed||now-observed>600_000)throw new Error("Stale Initiative source");
      const cursor=tx.get<{observed_ms:number}>("SELECT observed_ms FROM initiative_source_watermarks WHERE scope_key=? AND source_kind=?",key,opportunity.sourceKind);
      if(cursor&&observed<=cursor.observed_ms)throw new Error("Initiative source already consumed");
      if(tx.get("SELECT 1 FROM initiative_unanswered_topics WHERE scope_key=? AND session_id=? AND topic_hash=?",key,opportunity.sessionId,digest(opportunity.topicKey)))throw new Error("Unanswered Initiative topic");
      const own=tx.get<{n:number}>(`SELECT count(*) AS n FROM initiative_delivery WHERE scope_key=? AND state IN ${active}`,key)!.n;
      const all=tx.get<{n:number}>(`SELECT count(*) AS n FROM initiative_delivery WHERE state IN ${active}`)!.n;
      if(own>=limits.perRelationship||all>=limits.perRuntime)throw new Error("Initiative queue limit");
      const outcome:InitiativeDeliveryOutcome={schemaVersion:"1.0.0",recordType:"outcome",assistantId:scope.assistantId,userId:scope.userId,relationshipId:scope.relationshipId,deploymentId:scope.deploymentId,opportunityId:opportunity.opportunityId,correlationId:opportunity.correlationId,configurationId:opportunity.configurationId,configurationRevision:opportunity.configurationRevision,policyRevision:opportunity.policyRevision,state:"pending",occurredAt:new Date(now).toISOString(),reasonCodes:["eligible"],sourceRefs:[...opportunity.sourceRefs],preparedViewId:null,interactionId:null,lastDeliveryStage:"none",deliveryReceiptRef:null,acknowledgmentKind:null,response:"notObserved"};
      validate(outcome,"RelationalInitiativeOutcome");
      tx.run("INSERT INTO initiative_delivery (opportunity_id,scope_key,session_id,dedup_hash,topic_hash,observed_ms,expires_ms,updated_ms,version,state,opportunity_json,outcome_json) VALUES (?,?,?,?,?,?,?,?,1,'pending',?,?)",opportunity.opportunityId,key,opportunity.sessionId,digest(opportunity.dedupKey),digest(opportunity.topicKey),observed,expires,now,JSON.stringify(opportunity),JSON.stringify(outcome));
      tx.run("INSERT INTO initiative_source_watermarks VALUES (?,?,?) ON CONFLICT(scope_key,source_kind) DO UPDATE SET observed_ms=excluded.observed_ms",key,opportunity.sourceKind,observed);
      return {opportunity:structuredClone(opportunity),outcome,version:1,budget:"none"};
    });
  }
  transition(scope: InitiativeScope,id: string,expectedVersion: number,action: InitiativeDeliveryAction): InitiativeDeliveryRecord {
    return this.database.transaction(tx=>{
      const row=this.row(tx,scope,id),record=decode(row),{opportunity,outcome}=record,key=scopeKey(scope),now=this.clock(tx);
      if(row.version!==expectedVersion)throw new Error("Initiative revision conflict");
      const state=outcome.state;
      const requireState=(...allowed:State[])=>{if(!allowed.includes(state))throw new Error("Invalid Initiative transition");};
      if(action.type!=="finish"&&action.type!=="acknowledge"&&action.type!=="respond"&&action.type!=="emitted"&&Date.parse(opportunity.expiresAt)<=now)throw new Error("Initiative opportunity expired");
      switch(action.type){
        case "eligible": requireState("pending");outcome.state="eligible";outcome.reasonCodes=["eligible"];break;
        case "generated": requireState("eligible");outcome.state="generated";outcome.lastDeliveryStage="generated";outcome.preparedViewId=action.preparedViewId;outcome.interactionId=action.interactionId;break;
        case "queue": {
          requireState("generated");
          if(action.current(tx)!==true)throw new Error("Initiative boundary changed");
          const {perHour,perDay,minimumGapMs}=action.limits;
          if(!Number.isInteger(perHour)||perHour<0||perHour>12||!Number.isInteger(perDay)||perDay<0||perDay>48||!Number.isInteger(minimumGapMs)||minimumGapMs<120_000||minimumGapMs>7_200_000)throw new Error("Invalid Initiative opening limits");
          const counts=tx.get<{hour:number;day:number;last:number|null}>("SELECT coalesce(sum(reserved_ms>?),0) AS hour,count(*) AS day,max(reserved_ms) AS last FROM initiative_delivery WHERE scope_key=? AND budget_state IN ('held','charged') AND reserved_ms>?",now-3_600_000,key,now-86_400_000)!;
          if(counts.hour>=perHour||counts.day>=perDay)throw new Error("Initiative opening budget exhausted");
          if(counts.last!==null&&now-counts.last<minimumGapMs)throw new Error("Initiative opening cooldown");
          tx.run("INSERT INTO initiative_unanswered_topics VALUES (?,?,?,?)",key,opportunity.sessionId,digest(opportunity.topicKey),id);
          row.reserved_ms=now;row.budget_state="held";outcome.state="queued";outcome.lastDeliveryStage="queued";break;
        }
        case "beginEmission":
          requireState("queued");
          if(opportunity.executionMode==="replay"||row.emission_started||!uuid.test(action.receiptId))throw new Error("Invalid Initiative emission admission");
          if(action.current(tx)!==true)throw new Error("Initiative boundary changed");
          // Persist intent before returning the single-use host emission claim. This is
          // NOT an observed delivery stage. A crash here retains uncertain accounting.
          row.emission_started=1;row.receipt_id=action.receiptId;row.budget_state="charged";break;
        case "emitted":
          requireState("queued");
          if(!row.emission_started||row.receipt_id!==action.receiptId)throw new Error("Invalid Initiative emission receipt");
          outcome.state="emitted";outcome.lastDeliveryStage="emitted";outcome.deliveryReceiptRef=action.receiptId;outcome.reasonCodes=["deliveryEmitted"];break;
        case "acknowledge":
          requireState("emitted","acknowledged");
          if(action.sessionId!==opportunity.sessionId||!row.emission_started||action.receiptId!==row.receipt_id)throw new Error("Invalid Initiative acknowledgment");
          if(state==="acknowledged"&&outcome.acknowledgmentKind==="playbackCompleted"&&action.kind!=="playbackCompleted")throw new Error("Initiative acknowledgment cannot regress");
          outcome.state="acknowledged";outcome.lastDeliveryStage="acknowledged";outcome.deliveryReceiptRef=action.receiptId;outcome.acknowledgmentKind=action.kind;outcome.reasonCodes=[action.kind];break;
        case "finish": {
          if(terminal.has(state))throw new Error("Initiative outcome is terminal");
          const next:Record<string,State[]>={pending:["suppressed","expired","cancelled"],eligible:["suppressed","failed","expired","cancelled"],generated:["suppressed","expired","cancelled"],queued:["suppressed","failed","expired","cancelled"],emitted:["failed","cancelled","unknown"]};
          if(!next[state]?.includes(action.state))throw new Error("Invalid Initiative transition");
          outcome.state=action.state;outcome.reasonCodes=[...action.reasons];
          // The persisted emission-intent fence proves whether a refund is safe.
          // Once intent was issued, even an unobserved send is charged conservatively.
          if(row.budget_state==="held"&&!row.emission_started){row.budget_state="released";tx.run("DELETE FROM initiative_unanswered_topics WHERE scope_key=? AND session_id=? AND topic_hash=? AND opportunity_id=?",key,opportunity.sessionId,digest(opportunity.topicKey),id);}
          break;
        }
        case "respond":
          if(action.sessionId!==opportunity.sessionId||!["emitted","acknowledged"].includes(outcome.lastDeliveryStage))throw new Error("No emitted Initiative opening in this session");
          if(outcome.response!=="notObserved"&&outcome.response!==action.response&&!(outcome.response==="noResponse"&&action.response==="replied"))throw new Error("Initiative response conflict");
          outcome.response=action.response;
          if(action.response==="replied")tx.run("DELETE FROM initiative_unanswered_topics WHERE scope_key=? AND session_id=? AND topic_hash=?",key,opportunity.sessionId,digest(opportunity.topicKey));
          break;
        default: throw new Error("Invalid Initiative action");
      }
      outcome.occurredAt=new Date(now).toISOString();validate(outcome,"RelationalInitiativeOutcome");
      tx.run("UPDATE initiative_delivery SET version=version+1,state=?,outcome_json=?,updated_ms=?,reserved_ms=?,budget_state=?,emission_started=?,receipt_id=? WHERE opportunity_id=? AND scope_key=? AND version=?",outcome.state,JSON.stringify(outcome),now,row.reserved_ms,row.budget_state,row.emission_started,row.receipt_id,id,key,expectedVersion);
      return {opportunity,outcome,version:expectedVersion+1,budget:row.budget_state};
    });
  }
  /** Call only during exclusive host startup, before admitting any work. Pending
   * payloads never survive restart. Last observed stage remains truthful. */
  recover(): number {return this.settlePending(true);}
  /** Host maintenance, outside output. Expiry never turns into a delayed opening. */
  expirePending(): number {return this.settlePending(false);}
  private settlePending(restart:boolean):number {
    return this.database.transaction(tx=>{
      const now=this.clock(tx),rows=tx.all<Row>(`SELECT * FROM initiative_delivery WHERE state IN ${active}${restart?"":" AND expires_ms<=?"}`,...(restart?[]:[now]));
      // Exclusive startup only: the prior process no longer owns an executing call.
      // Preserve every reservation for rolling budgets and one-call deduplication.
      if(restart)tx.run("UPDATE initiative_inference_calls SET settled_ms=? WHERE settled_ms IS NULL",now);
      for(const row of rows){
        const {opportunity,outcome}=decode(row);
        outcome.state=outcome.state==="emitted"?"unknown":row.emission_started?"failed":"expired";
        outcome.reasonCodes=[outcome.state==="unknown"?"ackTimeout":restart?"restartExpired":outcome.state==="failed"?"outputFailed":"expired"];
        outcome.occurredAt=new Date(now).toISOString();validate(outcome,"RelationalInitiativeOutcome");
        const budget=row.budget_state==="held"?"released":row.budget_state;
        if(budget==="released")tx.run("DELETE FROM initiative_unanswered_topics WHERE opportunity_id=?",opportunity.opportunityId);
        tx.run("UPDATE initiative_delivery SET version=version+1,state=?,outcome_json=?,updated_ms=?,budget_state=? WHERE opportunity_id=?",outcome.state,JSON.stringify(outcome),now,budget,opportunity.opportunityId);
      }
      return rows.length;
    });
  }
  /** Explicit host-observed engagement/reset only; never silence, reconnect, or settings change. */
  resetSessionTopics(scope:InitiativeScope,sessionId:string):void {this.database.transaction(tx=>{this.clock(tx);tx.run("DELETE FROM initiative_unanswered_topics WHERE scope_key=? AND session_id=?",scopeKey(scope),sessionId);});}
  /** Outside the hot path. Keep source high-water marks, session unanswered keys and
   * clock fencing after the fixed 24-hour record horizon. No output payloads to replay. */
  prune():void {this.database.transaction(tx=>{
    const now=this.clock(tx);
    tx.run("DELETE FROM initiative_inference_calls WHERE opportunity_id IN (SELECT opportunity_id FROM initiative_inference_calls WHERE settled_ms<=? AND NOT EXISTS (SELECT 1 FROM initiative_delivery WHERE initiative_delivery.opportunity_id=initiative_inference_calls.opportunity_id AND state IN ('pending','eligible','generated','queued','emitted')) LIMIT 128)",now-86_400_000);
    tx.run(`DELETE FROM initiative_delivery WHERE opportunity_id IN (SELECT opportunity_id FROM initiative_delivery WHERE state NOT IN ${active} AND updated_ms<=? AND (reserved_ms IS NULL OR reserved_ms<=?) AND NOT EXISTS (SELECT 1 FROM initiative_inference_calls WHERE initiative_inference_calls.opportunity_id=initiative_delivery.opportunity_id) LIMIT 128)`,now-86_400_000,now-86_400_000);
  });}
}
