import {createHash} from 'node:crypto';
import type {Database,Transaction} from '@lifestream/storage-sqlite';
import type {PwceAdmissionCustody,PwceAdmissionIntent,PwceAdmissionOutcome,PwceAdmissionRecord} from '@lifestream/providers-pwce';
import {boundedJson,canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=():never=>{throw new Error('pwce_admission_custody_invalid');};
type Row={idempotency_key:string;invocation_id:string;intent_digest:string;intent_json:string;intent_sha256:string;outcome_json:string|null;outcome_sha256:string|null};
function parse<T>(text:string,digest:string):T{if(Buffer.byteLength(text)>262144||hash(text)!==digest)return fail();let value:unknown;try{value=JSON.parse(text);}catch{return fail();}if(!boundedJson(value,262144))return fail();return value as T;}
function project(row:Row):PwceAdmissionRecord{
  const intent=parse<PwceAdmissionIntent>(row.intent_json,row.intent_sha256);
  if(intent?.request?.idempotencyKey!==row.idempotency_key||intent.request.payload.invocationId!==row.invocation_id||intent.intentDigest!==row.intent_digest||(row.outcome_json===null)!==(row.outcome_sha256===null))return fail();
  return {intent,outcome:row.outcome_json===null?null:parse<PwceAdmissionOutcome>(row.outcome_json,row.outcome_sha256!)};
}
function encode(value:unknown):string{if(!boundedJson(value,262144))return fail();return canonicalJson(value);}

/** Original keys and incomplete intents survive restart; there is no lease,
 * expiry cleanup, replacement claim or implicit network retry here. */
export class SqlitePwceAdmissionCustody implements PwceAdmissionCustody {
  private readonly database:Database;private readonly capacity:number;
  constructor(database:Database,capacity=4096){if(!Number.isSafeInteger(capacity)||capacity<1||capacity>4096)fail();this.database=database;this.capacity=capacity;}
  read(key:string):PwceAdmissionRecord|undefined{const row=this.database.connection.prepare('SELECT * FROM pwce_admission_custody WHERE idempotency_key=?').get(key) as Row|undefined;return row?project(row):undefined;}
  reserve(input:PwceAdmissionIntent):boolean{
    const encoded=encode(input),intent=JSON.parse(encoded) as PwceAdmissionIntent,key=intent.request.idempotencyKey,invocationId=intent.request.payload.invocationId;
    if(!key||!invocationId||!/^[a-f0-9]{64}$/.test(intent.intentDigest))return fail();
    return this.database.transaction(tx=>{
      const existing=tx.get<Row>('SELECT * FROM pwce_admission_custody WHERE idempotency_key=? OR invocation_id=?',key,invocationId);
      if(existing){const record=project(existing);if(record.intent.intentDigest!==intent.intentDigest||existing.idempotency_key!==key||existing.invocation_id!==invocationId)return fail();return false;}
      if((tx.get<{count:number}>('SELECT COUNT(*) AS count FROM pwce_admission_custody')?.count??0)>=this.capacity)return fail();
      tx.run('INSERT INTO pwce_admission_custody VALUES (?,?,?,?,?,NULL,NULL)',key,invocationId,intent.intentDigest,encoded,hash(encoded));
      return true;
    });
  }
  complete(key:string,outcome:PwceAdmissionOutcome):PwceAdmissionRecord{
    const encoded=encode(outcome);return this.database.transaction((tx:Transaction)=>{
      const row=tx.get<Row>('SELECT * FROM pwce_admission_custody WHERE idempotency_key=?',key);if(!row)return fail();
      const original=project(row);if(original.outcome){if(row.outcome_json!==encoded)return fail();return original;}
      tx.run('UPDATE pwce_admission_custody SET outcome_json=?,outcome_sha256=? WHERE idempotency_key=? AND outcome_json IS NULL',encoded,hash(encoded),key);
      const saved=tx.get<Row>('SELECT * FROM pwce_admission_custody WHERE idempotency_key=?',key);if(!saved)return fail();return project(saved);
    });
  }
}
