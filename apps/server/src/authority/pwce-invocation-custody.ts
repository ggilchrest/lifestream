import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from '@lifestream/storage-sqlite';
import type * as M from '@lifestream/contracts/provider-messages';
import {pwceInvocationDigest} from '@lifestream/providers-pwce';
import type {PwceInvocationCustody,PwceInvocationRecord,PwceInvocationObservation} from '@lifestream/providers-pwce';
import {boundedJson,canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
type Row={invocation_id:string;idempotency_key:string;request_digest:string;request_json:string;request_sha256:string};
type ObservationRow={observation_json:string;sha256:string};
const fail=():never=>{throw new Error('pwce_invocation_custody_invalid');};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function encode(value:unknown):string{if(!boundedJson(value,262144))return fail();return canonicalJson(value);}
function decode<T>(json:string,sha256:string):T{if(Buffer.byteLength(json)>262144||hash(json)!==sha256)return fail();let value;try{value=JSON.parse(json);}catch{return fail();}if(!boundedJson(value,262144))return fail();return value as T;}
const statusBody=(status:PwceInvocationObservation['status'])=>{const {evidenceRef:_e,...rest}=status as typeof status&{evidenceRef?:M.ArtifactRef};return rest;};

/** No row eviction, claim reset or automatic dispatch retry. */
export class SqlitePwceInvocationCustody implements PwceInvocationCustody {
  private readonly database:Database;private readonly capacity:number;
  constructor(database:Database,capacity=4096){if(!Number.isSafeInteger(capacity)||capacity<1||capacity>4096)fail();this.database=database;this.capacity=capacity;}
  private observation(row:ObservationRow):PwceInvocationObservation {
    const value=decode<PwceInvocationObservation>(row.observation_json,row.sha256);
    if(typeof value.proofJson!=='string'||value.evidenceRef?.sha256!==hash(value.proofJson)||value.evidenceRef.byteLength!==Buffer.byteLength(value.proofJson))return fail();return value;
  }
  read(id:string):PwceInvocationRecord|undefined {
    const row=this.database.connection.prepare('SELECT * FROM pwce_invocation_custody WHERE invocation_id=?').get(id) as Row|undefined;if(!row)return undefined;
    const request=decode<M.CapabilityInvocationRequest>(row.request_json,row.request_sha256);
    if(request.payload?.invocationId!==id||request.idempotencyKey!==row.idempotency_key||pwceInvocationDigest(request)!==row.request_digest)return fail();
    const latest=this.database.connection.prepare('SELECT * FROM pwce_invocation_observations WHERE invocation_id=? ORDER BY sequence DESC LIMIT 1').get(id) as ObservationRow|undefined;
    const count=this.database.connection.prepare('SELECT COUNT(*) AS count FROM pwce_invocation_observations WHERE invocation_id=?').get(id) as {count:number};
    return {request,requestDigest:row.request_digest,latest:latest?this.observation(latest):null,observationCount:count.count};
  }
  claim(request:M.CapabilityInvocationRequest):boolean {
    const json=encode(request),owned=JSON.parse(json) as M.CapabilityInvocationRequest,digest=pwceInvocationDigest(owned);
    return this.database.transaction(tx=>{
      const existing=tx.get<Row>('SELECT * FROM pwce_invocation_custody WHERE invocation_id=? OR idempotency_key=?',owned.payload.invocationId,owned.idempotencyKey);
      if(existing){const record=this.read(existing.invocation_id)!;if(record.requestDigest!==digest||existing.invocation_id!==owned.payload.invocationId||existing.idempotency_key!==owned.idempotencyKey)return fail();return false;}
      if((tx.get<{count:number}>('SELECT COUNT(*) AS count FROM pwce_invocation_custody')?.count??0)>=this.capacity)return fail();
      tx.run('INSERT INTO pwce_invocation_custody VALUES (?,?,?,?,?)',owned.payload.invocationId,owned.idempotencyKey,digest,json,hash(json));return true;
    });
  }
  observe(id:string,input:PwceInvocationObservation):PwceInvocationRecord {
    const json=encode(input),owned=this.observation({observation_json:json,sha256:hash(json)});
    return this.database.transaction(tx=>{
      const original=this.read(id);if(!original||owned.status.invocationId!==id)return fail();
      if(original.latest){
        if(isDeepStrictEqual(original.latest,owned))return original;
        if(original.latest.terminal&&(!owned.terminal||!isDeepStrictEqual(statusBody(original.latest.status),statusBody(owned.status))))return fail();
      }
      const duplicate=tx.get<ObservationRow>('SELECT observation_json,sha256 FROM pwce_invocation_observations WHERE invocation_id=? AND evidence_sha256=?',id,owned.evidenceRef.sha256);
      if(duplicate){this.observation(duplicate);return fail();}
      if(original.observationCount>=17||!owned.terminal&&original.observationCount>=16)return fail();
      tx.run('INSERT INTO pwce_invocation_observations VALUES (?,?,?,?,?)',id,original.observationCount,owned.evidenceRef.sha256,json,hash(json));return this.read(id)!;
    });
  }
  readObservation(id:string,reference:M.ArtifactRef):PwceInvocationObservation|undefined {
    const row=this.database.connection.prepare('SELECT observation_json,sha256 FROM pwce_invocation_observations WHERE invocation_id=? AND evidence_sha256=?').get(id,reference.sha256) as ObservationRow|undefined;
    if(!row)return undefined;const observation=this.observation(row);if(!isDeepStrictEqual(reference,observation.evidenceRef))return undefined;return observation;
  }
}
