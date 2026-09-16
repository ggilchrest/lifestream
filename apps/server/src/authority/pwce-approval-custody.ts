import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from '@lifestream/storage-sqlite';
import type {PwceApprovalCustody,PwceApprovalIntent,PwceApprovalRecord,PwceApprovalObservation,PwceApprovalEvidence} from '@lifestream/providers-pwce';
import {boundedJson,canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
type Row={producer_key:string;invocation_id:string;intent_json:string;intent_sha256:string};
type ProofRow={sequence:number;proof_json:string;proof_sha256:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=():never=>{throw new Error('pwce_approval_custody_invalid');};
function encode(value:unknown):string{if(!boundedJson(value,262144))return fail();return canonicalJson(value);}
function decode<T>(json:string,sha256:string):T{if(Buffer.byteLength(json)>262144||hash(json)!==sha256)return fail();let value;try{value=JSON.parse(json);}catch{return fail();}if(!boundedJson(value,262144))return fail();return value as T;}
const fixed=(proof:PwceApprovalEvidence)=>{const {status:_s,approvedBy:_b,approvedAt:_a,humanProof:_h,...original}=proof;return original;};
function proof(row:ProofRow,key:string):PwceApprovalEvidence{
 const value=decode<PwceApprovalEvidence>(row.proof_json,row.proof_sha256);
 if(!value||value.requestKey!==key||value.kind!=='pwce.action.approval'||!['pending','approved','expired'].includes(value.status))return fail();return value;
}
/** Storage integrity and immutable history only. The adapter must run the
 * asynchronous published-schema/original-catalog verifier before use. */
export class SqlitePwceApprovalCustody implements PwceApprovalCustody {
 private readonly database:Database;private readonly capacity:number;
 constructor(database:Database,capacity=4096){if(!Number.isSafeInteger(capacity)||capacity<1||capacity>4096)fail();this.database=database;this.capacity=capacity;}
 read(key:string):PwceApprovalRecord|undefined{
  const row=this.database.connection.prepare('SELECT * FROM pwce_approval_custody WHERE producer_key=?').get(key) as Row|undefined;if(!row)return undefined;
  const intent=decode<PwceApprovalIntent>(row.intent_json,row.intent_sha256);
  if(intent.producerKey!==key||intent.expectation.producerKey!==key||intent.invocationId!==row.invocation_id||intent.request.payload.invocationId!==row.invocation_id)return fail();
  const rows=this.database.connection.prepare('SELECT * FROM pwce_approval_observations WHERE producer_key=? ORDER BY sequence').all(key) as ProofRow[];
  let previous:PwceApprovalEvidence|undefined;
  if(rows.length>17)return fail();
  for(const [index,item] of rows.entries()){
   if(item.sequence!==index)return fail();const value=proof(item,key);
   if(previous&&(!isDeepStrictEqual(fixed(previous),fixed(value))||previous.status!=='pending'&&!isDeepStrictEqual(previous,value)))return fail();previous=value;
  }
  const last=rows.at(-1);return {intent,latest:last?{proofJson:last.proof_json,sha256:last.proof_sha256}:null,observationCount:rows.length};
 }
 reserve(input:PwceApprovalIntent):boolean{
  const json=encode(input),owned=JSON.parse(json) as PwceApprovalIntent,key=owned.producerKey,id=owned.invocationId;
  if(typeof key!=='string'||!key||key.length>128||typeof id!=='string'||!id||id.length>128||owned.expectation?.producerKey!==key||owned.request?.payload?.invocationId!==id||!/^[a-f0-9]{64}$/.test(owned.confirmationDigest))return fail();
  return this.database.transaction(tx=>{
   const old=tx.get<Row>('SELECT * FROM pwce_approval_custody WHERE producer_key=? OR invocation_id=?',key,id);
   if(old){const record=this.read(old.producer_key)!;if(old.producer_key!==key||old.invocation_id!==id||canonicalJson(record.intent)!==json)return fail();return false;}
   if((tx.get<{n:number}>('SELECT COUNT(*) AS n FROM pwce_approval_custody')?.n??0)>=this.capacity)return fail();
   tx.run('INSERT INTO pwce_approval_custody VALUES (?,?,?,?)',key,id,json,hash(json));return true;
  });
 }
 observe(key:string,json:string):PwceApprovalRecord{
  if(typeof json!=='string'||Buffer.byteLength(json)>131072)return fail();const sha=hash(json),value=proof({sequence:0,proof_json:json,proof_sha256:sha},key);
  return this.database.transaction(tx=>{
   const record=this.read(key);if(!record)return fail();
   if(record.latest){const previous=decode<PwceApprovalEvidence>(record.latest.proofJson,record.latest.sha256);
    if(isDeepStrictEqual(previous,value))return record;
    if(previous.status!=='pending'||!isDeepStrictEqual(fixed(previous),fixed(value)))return fail();
   }
   if(record.observationCount>=17)return fail();
   tx.run('INSERT INTO pwce_approval_observations VALUES (?,?,?,?)',key,record.observationCount,json,sha);return this.read(key)!;
  });
 }
 readProof(key:string,sha256:string):PwceApprovalObservation|undefined{
  if(!this.read(key))return undefined;
  const row=this.database.connection.prepare('SELECT * FROM pwce_approval_observations WHERE producer_key=? AND proof_sha256=?').get(key,sha256) as ProofRow|undefined;
  if(!row)return undefined;proof(row,key);return {proofJson:row.proof_json,sha256:row.proof_sha256};
 }
}
