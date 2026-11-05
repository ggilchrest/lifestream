import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '@lifestream/storage-sqlite';

type Scope={principalId:string;assistantId:string};
type Reference={id:string;label:string;sha256:string;sampleRateHz:16000;durationMs:number};
/** Host-owned custody. Only explicit import tooling may call ingest; route
 * responses must use list, never getPrivate or the ingestion arguments. */
export class VoiceReferenceLibrary {
 constructor(private readonly database:Database){}
 list(scope:Scope):Reference[]{
  const rows=this.database.connection.prepare('SELECT reference_id AS id,label,sha256,length(pcm) AS bytes FROM voice_reference_library WHERE principal_id=? AND assistant_id=? ORDER BY label,reference_id').all(scope.principalId,scope.assistantId) as {id:string;label:string;sha256:string;bytes:number}[];
  return rows.map(r=>({id:r.id,label:r.label,sha256:r.sha256,sampleRateHz:16000,durationMs:r.bytes/32}));
 }
 getPrivate(scope:Scope,id:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return undefined;
  const row=this.database.connection.prepare('SELECT pcm,transcript FROM voice_reference_library WHERE principal_id=? AND assistant_id=? AND reference_id=?').get(scope.principalId,scope.assistantId,id) as {pcm:Uint8Array;transcript:string}|undefined;
  return row?{dataBase64:Buffer.from(row.pcm).toString('base64'),sampleRateHz:16000 as const,transcript:row.transcript,consent:true as const}:undefined;
 }
 select(scope:Scope,id:string){
  const reference=this.getPrivate(scope,id);if(!reference)return undefined;
  const fingerprint=createHash('sha256').update(Buffer.from(reference.dataBase64,'base64')).update('\0').update(reference.transcript).digest('hex');
  return {reference,current:()=>{const now=this.getPrivate(scope,id);return !!now&&createHash('sha256').update(Buffer.from(now.dataBase64,'base64')).update('\0').update(now.transcript).digest('hex')===fingerprint;}};
 }
 ingest(scope:Scope,input:{label:string;pcm:Uint8Array;transcript:string;consent:true;provenanceKey:string}):{id:string;created:boolean}{
  if(!scope.principalId||!scope.assistantId||typeof input.label!=='string'||!input.label.trim()||input.label.length>80||!(input.pcm instanceof Uint8Array)||input.pcm.length<64000||input.pcm.length>640000||input.pcm.length%2!==0||typeof input.transcript!=='string'||input.transcript.length>1000||input.consent!==true||typeof input.provenanceKey!=='string'||!/^[A-Za-z0-9._:-]{1,100}$/.test(input.provenanceKey))throw Error('Invalid reference import');
  const hash=createHash('sha256').update(input.pcm).digest('hex');
  return this.database.transaction(tx=>{
   const existing=tx.get<{id:string;transcript:string}>('SELECT reference_id AS id,transcript FROM voice_reference_library WHERE principal_id=? AND assistant_id=? AND sha256=?',scope.principalId,scope.assistantId,hash);
   if(existing){if(existing.transcript!==input.transcript.trim())throw Error('Duplicate reference has conflicting conditioning metadata');return {id:existing.id,created:false};}
   const usage=tx.get<{count:number;bytes:number}>('SELECT count(*) AS count,coalesce(sum(length(pcm)),0) AS bytes FROM voice_reference_library WHERE principal_id=? AND assistant_id=?',scope.principalId,scope.assistantId)!;
   if(usage.count>=64||usage.bytes+input.pcm.length>32*1024*1024)throw Error('Reference library capacity reached');
   const id=randomUUID();tx.run('INSERT INTO voice_reference_library VALUES (?,?,?,?,?,?,?,?,?)',id,scope.principalId,scope.assistantId,input.label.trim(),hash,Buffer.from(input.pcm),input.transcript.trim(),input.provenanceKey,new Date().toISOString());return {id,created:true};
  });
 }
}
