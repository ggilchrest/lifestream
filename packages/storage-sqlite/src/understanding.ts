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
/** Exact-content replay identity excludes generated IDs and configuration changes, not evidence revisions. */
export function hypothesisFingerprint(record:UnderstandingRecord):string {
  const explanations=(record.explanations as Record<string,unknown>[]).map(({explanationId:_id,...explanation})=>explanation).sort((a,b)=>understandingDigest(a).localeCompare(understandingDigest(b)));
  return understandingDigest({topics:[...record.topicRefs as string[]].sort(),explanations,unknown:record.unknownAlternative,uncertainty:record.uncertainty,coverage:record.sourceCoverage,evidence:(record.dependencyRefs as string[]).filter(ref=>ref.startsWith('evidence:')).sort()});
}
export function candidateFingerprint(record:UnderstandingRecord):string {return understandingDigest({kind:record.kind,content:record.content,topics:record.topicRefs,sources:(record.groundingRefs as string[]).filter(ref=>!ref.startsWith('topic-brief:')&&!ref.startsWith('hypothesis:')&&!ref.startsWith('claim:')).sort(),basis:(record.dependencyRefs as string[]).filter(ref=>ref.startsWith('source:')||ref.startsWith('evidence:')).sort()});}
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
    const artifacts=this.database.connection.prepare("SELECT payload_json AS payload FROM understanding_artifacts WHERE scope_key=? AND (boundary=? OR kind='hypothesis' AND json_extract(payload_json,'$.status')='rejected' OR kind='candidate' AND json_extract(payload_json,'$.status')='suppressed') AND fresh_until_ms>? ORDER BY rowid DESC LIMIT 64").all(key,boundary,time) as {payload:string}[];
    const jobs=this.database.connection.prepare("SELECT payload_json AS payload FROM understanding_work WHERE scope_key=? AND expires_ms>? AND payload_json IS NOT NULL ORDER BY created_ms DESC LIMIT 64").all(key,time) as {payload:string}[];
    return [...artifacts,...jobs].map(row=>JSON.parse(row.payload));
  }
  reviewHypothesis(scope:UnderstandingScope,id:string,revision:number,retryKey:string,digest:string,boundary:string,current:()=>boolean):{record:UnderstandingRecord;replay:boolean} {
    return this.database.transaction(tx=>{
      if(!current())throw new Error('Current review scope is unavailable');
      const key=scopeKey(scope),retry=understandingDigest(retryKey),known=tx.get<{digest:string;id:string;decision:string}>('SELECT request_digest AS digest,artifact_id AS id,decision FROM understanding_reviews WHERE scope_key=? AND retry_hash=?',key,retry);
      if(known&&(known.digest!==digest||known.id!==id||known.decision!=='reviewHypothesis'))throw new Error('Hypothesis review retry conflict');
      const row=tx.get<{payload:string;boundary:string}>('SELECT payload_json AS payload,boundary FROM understanding_artifacts WHERE scope_key=? AND artifact_id=? AND kind=\'hypothesis\' AND fresh_until_ms>?',key,id,this.now());
      if(!row)throw new Error('Hypothesis is unavailable or expired');
      const record=JSON.parse(row.payload) as UnderstandingRecord;
      if(known)return {record,replay:true};
      if(row.boundary!==boundary||record.revision!==revision||record.status!=='candidate'||this.hypothesisRejected(scope,record))throw new Error('Select a current candidate hypothesis at its current revision');
      record.status='reviewed';record.revision=revision+1;valid(record,'PreferenceHypothesis',scope);
      tx.run('UPDATE understanding_artifacts SET revision=?,payload_json=? WHERE artifact_id=?',record.revision,JSON.stringify(record),id);
      tx.run('INSERT INTO understanding_reviews VALUES (?,?,?,?,?)',key,retry,digest,id,'reviewHypothesis');
      return {record,replay:false};
    });
  }
  hypothesisRejected(scope:UnderstandingScope,record:UnderstandingRecord):boolean {
    return !!this.database.connection.prepare('SELECT 1 FROM understanding_hypothesis_rejections WHERE scope_key=? AND (artifact_id=? OR fingerprint=?) LIMIT 1').get(scopeKey(scope),String(record.hypothesisId),hypothesisFingerprint(record));
  }
  assertReviewRetry(scope:UnderstandingScope,retryKey:string,digest:string,id:string,decision:string):void {
    const known=this.database.connection.prepare('SELECT request_digest AS digest,artifact_id AS id,decision FROM understanding_reviews WHERE scope_key=? AND retry_hash=?').get(scopeKey(scope),understandingDigest(retryKey));
    if(known&&(known.digest!==digest||known.id!==id||known.decision!==decision))throw new Error('Hypothesis review retry conflict');
  }
  /** Caller supplies the owner transaction containing the external-journal application receipt. */
  applyHypothesisRejection(tx:Transaction,scope:UnderstandingScope,target:{hypothesisId:string;fingerprint:string;expectedRevision:number},retryKey:string,digest:string):void {
    const key=scopeKey(scope),retry=understandingDigest(retryKey),known=tx.get<{digest:string}>('SELECT request_digest AS digest FROM understanding_reviews WHERE scope_key=? AND retry_hash=?',key,retry);
    if(known&&known.digest!==digest)throw new Error('Hypothesis rejection retry conflict');
    tx.run('INSERT OR IGNORE INTO understanding_hypothesis_rejections VALUES (?,?,?,?)',key,target.hypothesisId,target.fingerprint,target.expectedRevision+1);
    const row=tx.get<{payload:string}>('SELECT payload_json AS payload FROM understanding_artifacts WHERE scope_key=? AND artifact_id=? AND kind=\'hypothesis\'',key,target.hypothesisId);
    if(row){const record=JSON.parse(row.payload) as UnderstandingRecord;if(record.status!=='rejected'){record.status='rejected';record.revision=Math.max(Number(record.revision)+1,target.expectedRevision+1);valid(record,'PreferenceHypothesis',scope);tx.run('UPDATE understanding_artifacts SET revision=?,payload_json=? WHERE artifact_id=?',record.revision,JSON.stringify(record),target.hypothesisId);}}
    tx.run('INSERT OR IGNORE INTO understanding_reviews VALUES (?,?,?,?,?)',key,retry,digest,target.hypothesisId,'rejectHypothesis');
    const jobs=tx.all<{payload:string}>(`SELECT payload_json AS payload FROM understanding_work WHERE scope_key=? AND state IN ${pending} AND payload_json IS NOT NULL`,key);
    for(const row of jobs){const work=JSON.parse(row.payload);work.state='cancelled';work.revision++;work.lastOutcome='cancelled';work.reason='Hypothesis rejection changed the current Discovery boundary; no automatic retry.';tx.run('UPDATE understanding_work SET state=\'cancelled\',payload_json=? WHERE work_id=?',JSON.stringify(work),work.workId);}
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
    for(const record of artifacts){const definition=record.recordType==="topicBrief"?"TopicBrief":record.recordType==="hypothesis"?"PreferenceHypothesis":record.recordType==="candidate"?"UnderstandingCandidate":undefined;if(!definition)throw new Error("Unsupported derived record type");valid(record,definition,scope);if(record.recordType==='hypothesis'&&(record.status!=='candidate'||record.revision!==1||this.hypothesisRejected(scope,record)))throw new Error('Rejected or non-candidate hypothesis cannot be published');}
    return this.database.transaction(tx=>{
      const row=tx.get<{payload:string;boundary:string;deadline:number}>(`SELECT payload_json AS payload,boundary,deadline_ms AS deadline FROM understanding_work WHERE scope_key=? AND work_id=? AND state IN ${pending}`,scopeKey(scope),id);
      if(!row?.payload||row.boundary!==boundary||row.deadline<=this.now()||!current(tx))return false;
      for(const artifact of artifacts)if(artifact.recordType==='hypothesis'&&this.hypothesisRejected(scope,artifact))throw new Error('Rejected hypothesis cannot be published');
      const work=JSON.parse(row.payload);
      for(const artifact of artifacts){
        const isBrief=artifact.recordType==='topicBrief',isCandidate=artifact.recordType==='candidate',id=isBrief?artifact.briefId:isCandidate?artifact.candidateId:artifact.hypothesisId,topic=isBrief?artifact.topicRef:(artifact.topicRefs as string[])[0];
        const expiry=isBrief?Date.parse(String(artifact.freshUntil)):isCandidate?Date.parse(String(artifact.expiresAt)):Date.parse(String(artifact.createdAt))+(work.budget.briefFreshnessSeconds as number)*1000;
        if(expiry<=this.now()||artifact.configurationRef!==work.configurationRef)throw new Error('Stale publication');
        if(isCandidate){
          if(artifact.status!=='proposed'||artifact.revision!==1||artifact.contextRef!==`snapshot:${boundary}`||Date.parse(String(artifact.builtAt))>this.now()||expiry>Date.parse(String(artifact.builtAt))+600000||this.candidateSuppressed(scope,artifact))throw new Error('Invalid or suppressed candidate publication');
          const parents=(artifact.groundingRefs as string[]).filter(ref=>/^(topic-brief|hypothesis):/u.test(ref));if(parents.length!==1||!(artifact.dependencyRefs as string[]).includes(parents[0]!))throw new Error('Candidate must pin one prepared parent');
          const match=/^(topic-brief|hypothesis):([^:]+):(\d+)$/u.exec(parents[0]!);if(!match)throw new Error('Invalid candidate parent');
          const stored=tx.get<{payload:string;expiry:number}>('SELECT payload_json AS payload,fresh_until_ms AS expiry FROM understanding_artifacts WHERE artifact_id=? AND scope_key=? AND boundary=?',match[2],scopeKey(scope),boundary);
          const parent=stored?JSON.parse(stored.payload):undefined;
          if(!parent||parent.revision!==Number(match[3])||!['prepared','candidate','reviewed'].includes(parent.status)||expiry>stored!.expiry)throw new Error('Candidate parent is unavailable or changed');
        }
        tx.run('INSERT INTO understanding_artifacts VALUES (?,?,?,?,?,?,?,?,?)',id,scopeKey(scope),scope.relationshipId,boundary,artifact.revision,artifact.recordType,topic,expiry,JSON.stringify(artifact));
        if(isCandidate){
          const prefix=artifact.kind==='discovery'?'Attributed source detail':'Optional tentative question';
          const content=`${topic}: ${prefix}: ${artifact.content} [optional; grants no authority]`;
          if(Buffer.byteLength(content)<=4096)tx.run('INSERT INTO understanding_projection(artifact_id,scope_key,boundary,content,fresh_until_ms) VALUES (?,?,?,?,?)',id,scopeKey(scope),boundary,content,expiry);
        }
      }
      work.state="published";work.admissionReceiptRef=`understanding-admission:${id}`;work.revision++;work.lastOutcome="succeeded";work.reason="Published validated derived records under current pinned dependencies; no source acquisition or user-evidence mutation.";work.producedRefs=artifacts.map(record=>record.recordType==="topicBrief"?`topic-brief:${record.briefId}:${record.revision}`:record.recordType==='candidate'?`candidate:${record.candidateId}:${record.revision}`:`hypothesis:${record.hypothesisId}:${record.revision}`);
      valid(work,"UnderstandingWork",scope);
      tx.run("UPDATE understanding_work SET state='published',payload_json=? WHERE work_id=?",JSON.stringify(work),id);
      return true;
    });
  }
  select(scope:UnderstandingScope,boundary:string,input:string):{id:string;content:string;rank:number;freshUntil:number}[] {
    const terms=[...new Set((input.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu)??[]).filter(term=>!['the','what','about','tell','please','could','would','does','explain','optional','source','attributed','detail','authority','grants','tentative','question','topic','discovery','candidate'].includes(term)))].slice(0,12);
    if(!terms.length)return [];
    if(!/^[a-f0-9]{64}$/u.test(boundary))return [];
    const match=`scope_key:"${scopeKey(scope)}" AND boundary:"${boundary}" AND content:(${terms.map(term=>`"${term}"`).join(" OR ")})`;
    const rows=this.database.connection.prepare("SELECT a.artifact_id AS id,a.payload_json AS payload,p.content,p.fresh_until_ms AS freshUntil FROM understanding_projection_fts JOIN understanding_projection p ON p.projection_id=understanding_projection_fts.rowid JOIN understanding_artifacts a ON a.artifact_id=p.artifact_id WHERE understanding_projection_fts MATCH ? AND p.scope_key=? AND p.boundary=? AND p.fresh_until_ms>? AND a.kind='candidate' AND json_extract(a.payload_json,'$.status')='proposed' LIMIT 32").all(match,scopeKey(scope),boundary,this.now()) as {id:string;payload:string;content:string;freshUntil:number}[];
    const words=(text:string):string[]=>text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
    const inputWords=new Set(words(input)),domain=/\b(?:in|from)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N} '\-]{1,60}?)(?=\s+(?:universe|franchise|series|context)\b|[,?!.]|$)/iu.exec(input)?.[1];
    const ranked=rows.flatMap((row,index)=>{const candidate=JSON.parse(row.payload) as UnderstandingRecord;if(this.candidateSuppressed(scope,candidate))return [];
      const topics=(candidate.topicRefs as string[]).map(ref=>words(ref.replace(/^topic:/u,''))),direct=topics.some(topic=>topic.length>0&&topic.every(word=>inputWords.has(word)));
      if(domain&&!topics.some(topic=>{const required=words(domain);return required.length>0&&required.every(word=>topic.includes(word));}))return [];
      return [{id:`discovery-candidate:${row.id}`,content:row.content,rank:(direct?0:100)+index,freshUntil:row.freshUntil,direct}];
    });
    const explicit=ranked.some(row=>row.direct),seen=new Set<string>();return ranked.filter(row=>{if(explicit&&!row.direct)return false;const fingerprint=understandingDigest(row.content);if(seen.has(fingerprint))return false;seen.add(fingerprint);return true;}).map(({direct:_direct,...row})=>row).sort((a,b)=>a.rank-b.rank);

  }
  candidateSuppressed(scope:UnderstandingScope,record:UnderstandingRecord):boolean {
    return !!this.database.connection.prepare('SELECT 1 FROM understanding_candidate_suppressions WHERE scope_key=? AND (artifact_id=? OR fingerprint=?) LIMIT 1').get(scopeKey(scope),String(record.candidateId),candidateFingerprint(record));
  }
  assertCandidateRetry(scope:UnderstandingScope,key:string,digest:string):void {
    const known=this.database.connection.prepare('SELECT request_digest AS digest FROM understanding_candidate_suppressions WHERE scope_key=? AND retry_hash=?').get(scopeKey(scope),understandingDigest(key));if(known&&known.digest!==digest)throw new Error('Candidate suppression retry conflict');
  }
  applyCandidateSuppression(tx:Transaction,scope:UnderstandingScope,target:{candidateId:string;fingerprint:string;expectedRevision:number},key:string,digest:string):void {
    this.assertCandidateRetry(scope,key,digest);
    tx.run('INSERT OR IGNORE INTO understanding_candidate_suppressions VALUES (?,?,?,?,?)',scopeKey(scope),target.candidateId,target.fingerprint,understandingDigest(key),digest);
    const row=tx.get<{payload:string}>('SELECT payload_json AS payload FROM understanding_artifacts WHERE scope_key=? AND artifact_id=? AND kind=\'candidate\'',scopeKey(scope),target.candidateId);
    if(row){const record=JSON.parse(row.payload) as UnderstandingRecord;if(record.status!=='suppressed'){record.status='suppressed';record.revision=Math.max(Number(record.revision)+1,target.expectedRevision+1);valid(record,'UnderstandingCandidate',scope);tx.run('UPDATE understanding_artifacts SET revision=?,payload_json=? WHERE artifact_id=?',record.revision,JSON.stringify(record),target.candidateId);}tx.run('DELETE FROM understanding_projection WHERE artifact_id=?',target.candidateId);}
  }
  purge(relationshipId:string):void {
    this.database.transaction(tx=>{tx.run("DELETE FROM understanding_artifacts WHERE relationship_id=?",relationshipId);tx.run("UPDATE understanding_work SET payload_json=NULL,state=CASE WHEN state='published' THEN state ELSE 'cancelled' END WHERE relationship_id=?",relationshipId);});
  }
}
