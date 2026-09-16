import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {boundedJson,canonicalJson,validateCapabilitySchema} from '@lifestream/runtime/capabilities/schema-validation';
import {PWCE_APPROVAL_EVIDENCE_SCHEMA} from './approval-recovery-bundle.ts';
import {PWCE_ADMISSION_SCHEMA} from './admission-bundle.ts';
import {EXPECTED_PWCE_CAPABILITY_BUNDLE} from './capability-bundle.ts';
import type {PwceCatalogRecord} from './capability-catalog.ts';
import type {PwcePreparedAction} from './authority-preview.ts';
import {PwceTransportError} from './transport.ts';

export type PwceApprovalEvidence={
 schemaVersion:'1.0.0';kind:'pwce.action.approval';approvalRef:string;requestKey:string;requestFingerprint:string;principalRef:string;siteRef:string;capabilityRef:string;
 status:'pending'|'approved'|'expired';createdAt:string;expiresAt:string;approvedBy:string|null;approvedAt:string|null;
 humanProof:{principalRef:string;authenticationMethod:'password'|'recovery_code';authenticatedAt:string;verifiedAt:string}|null;
 review:{request:Record<string,unknown>;idempotencyKey:string;effectSummary:string;effectClass:'reversible'};
 snapshot:{snapshotRef:string;sha256:string;expiresAt:string;snapshotJson:string};confirmationDigest:string;
};
export type PwceApprovalExpectation={catalog:PwceCatalogRecord;prepared:PwcePreparedAction;producerKey:string};
const bytes=(value:string)=>createHash('sha256').update(value).digest('hex');
const hash=(value:unknown)=>bytes(canonicalJson(value));
const fail=():never=>{throw new PwceTransportError('invalid_approval_evidence','PWCE original approval evidence is invalid');};
const snapshotSchema={$schema:PWCE_ADMISSION_SCHEMA.$schema,$id:PWCE_ADMISSION_SCHEMA.$id,$defs:PWCE_ADMISSION_SCHEMA.$defs,$ref:'#/$defs/RetainedSnapshotDocument'};

/** Verify history against the original host-retained catalog and operation.
 * Success proves consistency only: expiry, current authority and an exact
 * Human review must still be checked by the host before any admission. */
export async function verifyPwceApprovalEvidence(input:unknown,original:PwceApprovalExpectation,signal:AbortSignal):Promise<PwceApprovalEvidence>{
 if(signal.aborted||!boundedJson(input,131072)||!boundedJson(original,262144))return fail();
 const value=structuredClone(input),expected=structuredClone(original);
 if(!await validateCapabilitySchema(PWCE_APPROVAL_EVIDENCE_SCHEMA,value,signal,false,131072)||signal.aborted)return fail();
 const proof=value as PwceApprovalEvidence,{catalog,prepared,producerKey}=expected,binding=catalog.binding,descriptor=EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0];
 const fingerprint={principalRef:binding.principalRef,capabilityRef:descriptor.capabilityRef,capabilityVersion:descriptor.schemaVersion,operation:descriptor.operation,...prepared.input,executionEnvironmentRef:binding.executionEnvironmentRef,gatewayScope:{worldRef:binding.worldRef,...binding.identity}};
 if(!prepared.approval.required||prepared.approval.reference!==null&&prepared.approval.reference!==proof.approvalRef||proof.requestKey!==producerKey||proof.review.idempotencyKey!==producerKey||proof.requestFingerprint!==canonicalJson(fingerprint)||!isDeepStrictEqual(proof.review.request,fingerprint)||proof.principalRef!==binding.principalRef||proof.siteRef!==prepared.input.siteRef||proof.capabilityRef!==descriptor.capabilityRef)return fail();
 if(proof.review.effectSummary!==`Set brightness of ${prepared.input.targetEntityId} at ${prepared.input.siteRef} to level ${prepared.input.parameters.level} on the 0–1 scale.`||proof.review.effectClass!==descriptor.effectClass)return fail();
 if(Buffer.byteLength(proof.snapshot.snapshotJson)>32768||bytes(proof.snapshot.snapshotJson)!==proof.snapshot.sha256||hash({review:proof.review,snapshotSha256:proof.snapshot.sha256,expiresAt:proof.expiresAt})!==proof.confirmationDigest)return fail();
 let retained:Record<string,unknown>;try{retained=JSON.parse(proof.snapshot.snapshotJson) as Record<string,unknown>;}catch{return fail();}
 if(!await validateCapabilitySchema(snapshotSchema,retained,signal)||signal.aborted)return fail();
 const source=retained.snapshot as Record<string,unknown>,scope=retained.scope as unknown[],{profileId:_p,profileVersion:_v,...body}=source;
 if(proof.snapshot.snapshotRef!==catalog.producerSnapshotRef||source.snapshotRef!==catalog.producerSnapshotRef||proof.snapshot.expiresAt!==catalog.snapshot.expiresAt||source.expiresAt!==catalog.snapshot.expiresAt||source.issuedAt!==catalog.snapshot.issuedAt||source.principalRef!==binding.principalRef||!isDeepStrictEqual(source.siteRefs,binding.siteRefs)||hash(body)!==catalog.producerDigest||scope[0]!==binding.authorityContextRef||scope[1]!==binding.principalRef||scope[3]!==catalog.producerRevision||!isDeepStrictEqual(scope[4],binding.siteRefs)||!isDeepStrictEqual(scope.slice(5),[binding.identity.assistantRef,binding.identity.endpointRef,binding.identity.participantRefs,binding.identity.audienceRef,binding.worldRef,binding.executionEnvironmentRef]))return fail();
 const created=Date.parse(proof.createdAt),expires=Date.parse(proof.expiresAt);
 if(created>Date.now()||created<Date.parse(catalog.snapshot.issuedAt)||expires<=created||expires-created>120000||expires>Date.parse(catalog.snapshot.expiresAt))return fail();
 if(proof.status==='approved'){
  const human=proof.humanProof!,approved=Date.parse(proof.approvedAt!);
  if(human.principalRef!==proof.approvedBy||Date.parse(human.authenticatedAt)>Date.parse(human.verifiedAt)||Date.parse(human.verifiedAt)>approved||approved<created||approved>=expires||approved>Date.now())return fail();
 }else if(proof.humanProof!==null||proof.approvedBy!==null||proof.approvedAt!==null)return fail();
 if(signal.aborted)return fail();return structuredClone(proof);
}
