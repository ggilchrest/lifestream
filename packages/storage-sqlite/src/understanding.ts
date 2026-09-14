import { createHash } from "node:crypto";
import { createContractValidator } from "@lifestream/contracts";
import type { Database, Transaction } from "./database.ts";

export type UnderstandingScope = { assistantId: string; userId: string; relationshipId: string; deploymentId: string };
export type UnderstandingRecord = Record<string, unknown> & UnderstandingScope;
const validator = createContractValidator();
export const understandingDigest = (value: unknown): string => {
  const canonical = (input: unknown): string => Array.isArray(input) ? `[${input.map(canonical).join(",")}]` : input && typeof input === "object" ? `{${Object.keys(input).sort().map(key=>`${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(input);
  return createHash("sha256").update(canonical(value)).digest("hex");
};
const scopeKey = (scope: UnderstandingScope) => understandingDigest([scope.assistantId,scope.userId,scope.relationshipId,scope.deploymentId]);
const valid = (record: UnderstandingRecord, definition: string, scope: UnderstandingScope): void => {
  const result=validator.validate(`https://lifestream.dev/contracts/personal-understanding/1.0.0#/$defs/${definition}`, record);
  if(!result.valid)throw new Error(`Invalid Discovery record: ${result.errors.slice(0,3).map(error=>`${error.instancePath} ${error.message}`).join("; ")}`);
  if(scopeKey(record)!==scopeKey(scope))throw new Error("Cross-scope Discovery record");
};
const pending = "('queued','admitted','running','paused','staged')";

export class UnderstandingRepository {
  private readonly database: Database;
  private readonly now: () => number;
  constructor(database: Database, now: () => number = Date.now) { this.database=database;this.now=now; }
  /** Payloads expire; hashed admission identities remain to prevent historical replay. */
  recover(): void {
    this.database.transaction(tx=>{
      const time=this.now();
      const interrupted=tx.all<{workId:string;payload:string}>(`SELECT work_id AS workId,payload_json AS payload FROM understanding_work WHERE state IN ${pending} AND payload_json IS NOT NULL`);
      for(const row of interrupted){const record=JSON.parse(row.payload);record.state="cancelled";record.revision++;record.lastOutcome="cancelled";record.reason="Restart interrupted preparation; explicit new admission requires current dependencies.";tx.run("UPDATE understanding_work SET state='cancelled',payload_json=? WHERE work_id=?",JSON.stringify(record),row.workId);}
      tx.run("UPDATE understanding_work SET payload_json=NULL WHERE expires_ms<=?",time);
      tx.run("DELETE FROM understanding_artifacts WHERE fresh_until_ms<=?",time);
    });
  }
  /** Bounded maintenance runs outside conversation; expired data is never selected while awaiting it. */
  cleanupExpired(): void {
    this.database.transaction(tx=>{
      tx.run("UPDATE understanding_work SET payload_json=NULL,state=CASE WHEN state IN ('queued','admitted','running','paused','staged') THEN 'expired' ELSE state END WHERE work_id IN (SELECT work_id FROM understanding_work WHERE expires_ms<=? AND payload_json IS NOT NULL LIMIT 128)",this.now());
      tx.run("DELETE FROM understanding_artifacts WHERE artifact_id IN (SELECT artifact_id FROM understanding_artifacts WHERE fresh_until_ms<=? LIMIT 128)",this.now());
    });
  }
  admit(scope:UnderstandingScope, work:UnderstandingRecord, requestDigest:string, snapshotKey:string, boundary:string, current:(tx:Transaction)=>boolean): {record:UnderstandingRecord; replay:boolean} {
    valid(work,"UnderstandingWork",scope);
    if(work.state!=="queued"||work.revision!==1||!(/^[a-f0-9]{64}$/u.test(boundary)))throw new Error("Invalid initial work state");
    return this.database.transaction(tx=>{
      if(!current(tx))throw new Error("Discovery boundary changed");
      const now=this.now(),key=scopeKey(scope),retry=understandingDigest(work.idempotencyKey);
      const existing=tx.get<{digest:string;payload:string|null}>("SELECT request_digest AS digest,payload_json AS payload FROM understanding_work WHERE scope_key=? AND retry_hash=?",key,retry);
      if(existing){if(existing.digest!==requestDigest||!existing.payload)throw new Error("Discovery retry conflict or expired receipt");return {record:JSON.parse(existing.payload),replay:true};}
      if(tx.get("SELECT 1 FROM understanding_work WHERE scope_key=? AND snapshot_key=?",key,snapshotKey))throw new Error("This topic and snapshot were already admitted");
      const budget=work.budget as Record<string,number>,created=Date.parse(String(work.createdAt)),deadline=Date.parse(String(work.deadlineAt)),expires=Date.parse(String(work.expiresAt));
      if(!Number.isFinite(now)||created>now||now-created>1000||deadline<=now||deadline>created+budget.jobDeadlineSeconds!*1000||expires<deadline||expires>created+budget.pendingJobTtlSeconds!*1000)throw new Error("Invalid work clock or deadline");
      const jobs=tx.get<{n:number}>("SELECT count(*) AS n FROM understanding_work WHERE scope_key=? AND created_ms>?",key,now-86400000)!.n;
      const queued=tx.get<{n:number}>(`SELECT count(*) AS n FROM understanding_work WHERE state IN ${pending} AND expires_ms>?`,now)!.n;
      if(jobs>=budget.jobsPerDay!||queued>=budget.pendingJobsPerRuntime!)throw new Error("Discovery admission budget exhausted");
      tx.run("INSERT INTO understanding_work VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",work.workId,key,scope.relationshipId,retry,requestDigest,snapshotKey,boundary,"queued",created,deadline,expires,JSON.stringify(work));
      return {record:structuredClone(work),replay:false};
    });
  }
  list(scope:UnderstandingScope,boundary:string):UnderstandingRecord[] {
    const time=this.now(),key=scopeKey(scope);
    const artifacts=this.database.connection.prepare("SELECT payload_json AS payload FROM understanding_artifacts WHERE scope_key=? AND boundary=? AND fresh_until_ms>? ORDER BY rowid DESC LIMIT 64").all(key,boundary,time) as {payload:string}[];
    const jobs=this.database.connection.prepare("SELECT payload_json AS payload FROM understanding_work WHERE scope_key=? AND expires_ms>? AND payload_json IS NOT NULL ORDER BY created_ms DESC LIMIT 64").all(key,time) as {payload:string}[];
    return [...artifacts,...jobs].map(row=>JSON.parse(row.payload));
  }
  work(scope:UnderstandingScope,id:string):UnderstandingRecord|undefined {
    const row=this.database.connection.prepare("SELECT payload_json AS payload FROM understanding_work WHERE scope_key=? AND work_id=? AND expires_ms>?").get(scopeKey(scope),id,this.now()) as {payload:string|null}|undefined;
    return row?.payload?JSON.parse(row.payload):undefined;
  }
  start(scope:UnderstandingScope,id:string):boolean {
    return this.database.transaction(tx=>{
      const work=this.work(scope,id);
      if(!work||work.state!=="queued"||Date.parse(String(work.deadlineAt))<=this.now())return false;
      work.state="running";work.revision=Number(work.revision)+1;work.admissionReceiptRef=`understanding-admission:${id}`;
      work.reason="Current dependencies admitted for bounded Discovery work.";
      valid(work,"UnderstandingWork",scope);
      tx.run("UPDATE understanding_work SET state='running',payload_json=? WHERE work_id=?",JSON.stringify(work),id);
      return true;
    });
  }
  cancel(scope:UnderstandingScope,id:string,revision:number,retryKey:string,requestDigest:string):UnderstandingRecord {
    return this.database.transaction(tx=>{
      const key=scopeKey(scope),retry=understandingDigest(retryKey);
      const known=tx.get<{digest:string;id:string}>("SELECT request_digest AS digest,work_id AS id FROM understanding_commands WHERE scope_key=? AND retry_hash=?",key,retry);
      const work=this.work(scope,id);
      if(known){if(known.digest!==requestDigest||known.id!==id||!work)throw new Error("Cancellation retry conflict or expired payload");return work;}
      if(!work||work.revision!==revision||!["queued","admitted","running","paused","staged"].includes(String(work.state)))throw new Error("Select current unfinished work before cancelling");
      work.state="cancelled";work.revision=Number(work.revision)+1;work.lastOutcome="cancelled";work.reason="Explicitly cancelled; no automatic retry.";
      valid(work,"UnderstandingWork",scope);
      tx.run("UPDATE understanding_work SET state='cancelled',payload_json=? WHERE work_id=?",JSON.stringify(work),id);
      tx.run("INSERT INTO understanding_commands VALUES (?,?,?,?)",key,retry,requestDigest,id);
      return work;
    });
  }
  finish(scope:UnderstandingScope,id:string,state:"cancelled"|"failed",reason:string):void {
    this.database.transaction(tx=>{const row=tx.get<{payload:string}>(`SELECT payload_json AS payload FROM understanding_work WHERE scope_key=? AND work_id=? AND state IN ${pending}`,scopeKey(scope),id);if(!row?.payload)return;const record=JSON.parse(row.payload);record.state=state;record.revision++;record.lastOutcome=state;record.reason=reason;tx.run("UPDATE understanding_work SET state=?,payload_json=? WHERE work_id=?",state,JSON.stringify(record),id);});
  }
  publish(scope:UnderstandingScope,id:string,boundary:string,artifacts:UnderstandingRecord[],current:(tx:Transaction)=>boolean):boolean {
    if(!artifacts.length||artifacts.length>8)throw new Error("Invalid publication size");
    for(const record of artifacts){const definition=record.recordType==="topicBrief"?"TopicBrief":record.recordType==="hypothesis"?"PreferenceHypothesis":undefined;if(!definition)throw new Error("Unsupported derived record type");valid(record,definition,scope);}
    return this.database.transaction(tx=>{
      const row=tx.get<{payload:string;boundary:string;deadline:number}>(`SELECT payload_json AS payload,boundary,deadline_ms AS deadline FROM understanding_work WHERE scope_key=? AND work_id=? AND state IN ${pending}`,scopeKey(scope),id);
      if(!row?.payload||row.boundary!==boundary||row.deadline<=this.now()||!current(tx))return false;
      const work=JSON.parse(row.payload);
      for(const artifact of artifacts){const isBrief=artifact.recordType==="topicBrief",id=isBrief?artifact.briefId:artifact.hypothesisId,topic=isBrief?artifact.topicRef:(artifact.topicRefs as string[])[0],expiry=isBrief?Date.parse(String(artifact.freshUntil)):Date.parse(String(artifact.createdAt))+(work.budget.briefFreshnessSeconds as number)*1000;if(expiry<=this.now()||artifact.configurationRef!==work.configurationRef)throw new Error("Stale publication");
        tx.run("INSERT INTO understanding_artifacts VALUES (?,?,?,?,?,?,?,?,?)",id,scopeKey(scope),scope.relationshipId,boundary,artifact.revision,artifact.recordType,topic,expiry,JSON.stringify(artifact));
        // Each projection is bounded before indexing. Foreground lookup reads at most 32 rows.
        for(const claim of isBrief?[...artifact.claims as {text:string;claimId:string;sourceRefs:string[];qualifier:string}[],...artifact.aliasClaims as {text:string;claimId:string;sourceRefs:string[];qualifier:string}[]]:[]){
          const content=`${artifact.topicRef}: ${claim.text} [${claim.qualifier} source assertion: ${claim.sourceRefs.join(", ")}]`;
          if(Buffer.byteLength(content)>4096)continue;
          tx.run("INSERT INTO understanding_projection(artifact_id,scope_key,boundary,content,fresh_until_ms) VALUES (?,?,?,?,?)",artifact.briefId,scopeKey(scope),boundary,content,expiry);
        }
      }
      work.state="published";work.admissionReceiptRef=`understanding-admission:${id}`;work.revision++;work.lastOutcome="succeeded";work.reason="Published validated derived records under current pinned dependencies; no source acquisition or user-evidence mutation.";work.producedRefs=artifacts.map(record=>record.recordType==="topicBrief"?`topic-brief:${record.briefId}:${record.revision}`:`hypothesis:${record.hypothesisId}:${record.revision}`);
      valid(work,"UnderstandingWork",scope);
      tx.run("UPDATE understanding_work SET state='published',payload_json=? WHERE work_id=?",JSON.stringify(work),id);
      return true;
    });
  }
  select(scope:UnderstandingScope,boundary:string,input:string):{id:string;content:string;rank:number;freshUntil:number}[] {
    const terms=[...new Set((input.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu)??[]).filter(term=>!['the','what','about','tell','please','could','would','does','explain'].includes(term)))].slice(0,12);
    if(!terms.length)return [];
    if(!/^[a-f0-9]{64}$/u.test(boundary))return [];
    const match=`scope_key:"${scopeKey(scope)}" AND boundary:"${boundary}" AND content:(${terms.map(term=>`"${term}"`).join(" OR ")})`;
    return (this.database.connection.prepare("SELECT p.projection_id AS id,p.content,p.fresh_until_ms AS freshUntil FROM understanding_projection_fts JOIN understanding_projection p ON p.projection_id=understanding_projection_fts.rowid WHERE understanding_projection_fts MATCH ? AND p.scope_key=? AND p.boundary=? AND p.fresh_until_ms>? LIMIT 32").all(match,scopeKey(scope),boundary,this.now()) as {id:number;content:string;freshUntil:number}[]).map((row,rank)=>({...row,id:`discovery:${row.id}`,rank}));
  }
  purge(relationshipId:string):void {
    this.database.transaction(tx=>{tx.run("DELETE FROM understanding_artifacts WHERE relationship_id=?",relationshipId);tx.run("UPDATE understanding_work SET payload_json=NULL,state=CASE WHEN state='published' THEN state ELSE 'cancelled' END WHERE relationship_id=?",relationshipId);});
  }
}
