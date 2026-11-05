import {createHash, randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import type {Database} from '@lifestream/storage-sqlite';

export type InitiativeReceiptScope={assistantId:string;userId:string;relationshipId:string;deploymentId?:string};
const schema='https://lifestream.dev/contracts/initiative-operation-receipt/1.0.0';
const validator=createContractValidator();
export const canonicalInitiativeRequest=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonicalInitiativeRequest).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonicalInitiativeRequest((v as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(v);
/** SHA-256 of UTF-8 canonical JSON for the entire original validated v1 body,
 * including its original idempotencyKey. Arrays keep their original order. */
export const initiativeRequestDigest=(request:unknown):string=>createHash('sha256').update(canonicalInitiativeRequest(request),'utf8').digest('hex');

export function initiativeReceiptMetadata(scope:InitiativeReceiptScope,request:Record<string,unknown>,binding:string):Record<string,unknown> {
 return {schemaVersion:'1.0.0',assistantId:scope.assistantId,userId:scope.userId,relationshipId:scope.relationshipId,deploymentId:scope.deploymentId,operation:request.operation,requestDigest:initiativeRequestDigest(request),binding};
}

/** A SELECT-only reconciliation seam. Missing receipts never admit/replay work.
 * An unknown result can still commit later; it is not permission to retry. */
export function inspectInitiativeOperationReceipt(database:Database,scope:InitiativeReceiptScope,request:unknown,current:()=>boolean):{status:number;body:Record<string,unknown>} {
 const error=(status:number,code:string)=>({status,body:{schemaVersion:'1.0.0',code,message:'The operation receipt cannot be inspected.',retryable:false,correlationId:randomUUID()}});
 if(!validator.validate(schema+'#/$defs/Request',request).valid)return error(422,'invalid_operation_receipt_request');
 if(!current())return error(409,'current_scope_required');
 if(!scope.deploymentId)return error(409,'identity_mapping_required');
 const q=request as {operation:string;idempotencyKey:string;requestDigest:string};
 const row=database.connection.prepare('SELECT operation,response_json AS response FROM assistant_relationship_idempotency WHERE idempotency_key=? AND relationship_id=?').get(q.idempotencyKey,scope.relationshipId) as {operation:string;response:string}|undefined;
 const active=database.connection.prepare("SELECT configuration_id AS id FROM assistant_relationship_configurations WHERE relationship_id=? AND json_extract(payload_json,'$.status')='active'").get(scope.relationshipId) as {id:string}|undefined;
 let state='unknown',recorded:Record<string,unknown>|null=null;
 if(row){
  state='unavailable';
  try{
   const result=JSON.parse(row.response) as {status:number;body:Record<string,unknown>;initiativeReceiptMetadata?:Record<string,unknown>};
   const m=result.initiativeReceiptMetadata;
   if(Object.keys(result).length!==3||!Object.hasOwn(result,'status')||!Object.hasOwn(result,'body')||!Object.hasOwn(result,'initiativeReceiptMetadata'))throw Error('Unverifiable receipt envelope');
   const expectedKeys=['schemaVersion','assistantId','userId','relationshipId','deploymentId','operation','requestDigest','binding'];
   if(m&&Object.keys(m).length===expectedKeys.length&&expectedKeys.every(k=>Object.hasOwn(m,k))&&m.schemaVersion==='1.0.0'&&['assistantId','userId','relationshipId','deploymentId'].every(k=>m[k]===scope[k as keyof InitiativeReceiptScope])&&m.operation===q.operation&&m.requestDigest===q.requestDigest&&m.binding===row.operation&&row.operation.startsWith('extension:initiative:'+q.operation+':')){
    const body=result.body;
    if(Number.isInteger(result.status)&&result.status>=200&&result.status<300&&validator.validate('https://lifestream.dev/contracts/initiative-api/1.0.0#/$defs/Response',body).valid&&body.relationshipId===scope.relationshipId&&body.operation===q.operation&&Array.isArray(body.records)&&body.records.length===1){
     const config=body.records[0] as Record<string,unknown>;
     if(config.recordType==='configuration'&&config.assistantId===scope.assistantId&&config.userId===scope.userId&&config.deploymentId===scope.deploymentId&&config.relationshipId===scope.relationshipId&&body.activeStateChanged===(q.operation==='activate')&&(q.operation==='activate'?config.lifecycle==='active'&&body.activeConfigurationId===config.configurationId:config.lifecycle==='draft'&&body.activeConfigurationId!==config.configurationId)){
      recorded={configurationId:config.configurationId,revision:config.revision,activeStateChanged:body.activeStateChanged,activeConfigurationId:body.activeConfigurationId};state='committed';
     }
    }
   }
  }catch{/* A legacy or unverifiable receipt is not a reconstructed outcome. */}
 }
 if(!current())return error(409,'current_scope_required');
 const body={schemaVersion:'1.0.0',state,operation:q.operation,requestDigest:q.requestDigest,recorded,currentActiveConfigurationId:active?.id??null,mutationDispatched:false};
 if(!validator.validate(schema+'#/$defs/Response',body).valid)return error(409,'operation_receipt_unavailable');
 return {status:200,body};
}
