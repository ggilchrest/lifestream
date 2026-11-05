import {healthSourceConsentEnvelope,healthSourceConsentPin,healthSourceConsentResponse} from '@lifestream/contracts/mobile-context-health-source-consent';
import {calendarSourceConsentEnvelope,calendarSourceConsentPin,calendarSourceConsentResponse} from '@lifestream/contracts/mobile-context-calendar-source-consent';
import {calendarPolicyEnvelope,calendarPolicyPin,calendarPolicyResponse} from '@lifestream/contracts/mobile-context-calendar-policy-owner';
import {healthPolicyEnvelope,healthPolicyPin,healthPolicyResponse,type HealthPolicyResult} from '@lifestream/contracts/mobile-context-policy-owner';
import {HealthPolicyOwner,type HealthPolicyActor} from './mobile-context-policy-owner.ts';
/** Host resolves real Auth, administration, CSRF and personal-source authority.
 * No headers, cookies, client flags or identity parsers live in this adapter. */
export function healthPolicyOperation(owner:HealthPolicyOwner,input:unknown,resolve:()=>HealthPolicyActor){
 const envelope=healthPolicyEnvelope(input);if(!envelope)return {status:422,body:{code:'health_policy_invalid'}};
 try{const actor=resolve();let result;
  switch(envelope.operation){case'inspect':result=owner.inspect(actor,envelope.payload);break;case'preview':result=owner.preview(actor,envelope.payload);break;case'apply':result=owner.apply(actor,envelope.payload,envelope.previewDigest);break;case'reconcile':result=owner.reconcile(actor,envelope.payload);break;}
  // Reconciliation owns its final publication guards; nothing calls authority
  // after that point. Contract snapshot and serialization are pure data work.
  const body=healthPolicyResponse({producerPin:healthPolicyPin,schemaVersion:'1.0.0',result});return body?{status:200,body}:{status:503,body:{code:'health_policy_unavailable'}};
 }catch{return {status:403,body:{code:'health_policy_scope'}};}
}

export function calendarPolicyOperation(owner:HealthPolicyOwner,input:unknown,resolve:()=>HealthPolicyActor){
 const envelope=calendarPolicyEnvelope(input);if(!envelope)return {status:422,body:{code:'calendar_policy_invalid'}};
 try{const actor=resolve();let result;
  switch(envelope.operation){case'inspect':result=owner.inspect(actor,envelope.payload);break;case'preview':result=owner.preview(actor,envelope.payload);break;case'apply':result=owner.apply(actor,envelope.payload,envelope.previewDigest);break;case'reconcile':result=owner.reconcile(actor,envelope.payload);break;}
  const body=calendarPolicyResponse({producerPin:calendarPolicyPin,schemaVersion:'1.0.0',result});return body?{status:200,body}:{status:503,body:{code:'calendar_policy_unavailable'}};
 }catch{return {status:403,body:{code:'calendar_policy_scope'}};}
}

export function calendarSourceConsentOperation(owner:HealthPolicyOwner,input:unknown,resolve:()=>HealthPolicyActor){
 const envelope=calendarSourceConsentEnvelope(input);if(!envelope)return {status:422,body:{code:'calendar_source_consent_invalid'}};
 try{const actor=resolve();let result;
 switch(envelope.operation){case'describe':result=owner.describeConsent(actor,envelope.payload.enrollmentId);break;case'inspect':result=owner.inspectConsent(actor,envelope.payload);break;case'requestApproval':result=owner.requestConsent(actor,envelope.payload);break;case'approve':case'revoke':result=owner.applyConsent(actor,envelope.payload);break;case'reconcile':result=owner.reconcile(actor,envelope.payload);break;}
 const body=calendarSourceConsentResponse({producerPin:calendarSourceConsentPin,schemaVersion:'1.0.0',result});return body?{status:200,body}:{status:503,body:{code:'calendar_source_consent_unavailable'}};
 }catch{return {status:403,body:{code:'calendar_source_consent_scope'}};}
}

export function healthSourceConsentOperation(owner:HealthPolicyOwner,input:unknown,resolve:()=>HealthPolicyActor){
 const envelope=healthSourceConsentEnvelope(input);if(!envelope)return {status:422,body:{code:'health_source_consent_invalid'}};
 try{const actor=resolve();let result;
 switch(envelope.operation){case'describe':result=owner.describeHealthConsent(actor,envelope.payload.enrollmentId,envelope.payload.category);break;case'inspect':result=owner.inspectConsent(actor,envelope.payload);break;case'requestApproval':result=owner.requestConsent(actor,envelope.payload);break;case'approve':case'revoke':result=owner.applyConsent(actor,envelope.payload);break;case'reconcile':result=owner.reconcile(actor,envelope.payload);break;}
 const body=healthSourceConsentResponse({producerPin:healthSourceConsentPin,schemaVersion:'1.0.0',result});return body?{status:200,body}:{status:503,body:{code:'health_source_consent_unavailable'}};
 }catch{return {status:403,body:{code:'health_source_consent_scope'}};}
}
