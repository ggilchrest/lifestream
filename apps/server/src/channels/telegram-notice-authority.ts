import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CanonicalGrantRepository,TelegramPairingRepository,type Database,type TelegramBinding,type CanonicalHumanContext,type AuthorityCommand} from '@lifestream/storage-sqlite';
import type {AuthorityRequest,AuthorityDispatchRequest,GrantRequest} from '@lifestream/contracts/provider-messages';
import {evaluateCanonicalGrant} from '@lifestream/runtime/authority/grants';
import {capabilityInputDigest} from '@lifestream/runtime/capabilities/resolver';
import {AUTH_PARAMETERS,type LocalAuthentication,type LocalContext} from '../auth/local-auth.ts';
import type {TelegramAlertAuthority,TelegramAlertSession} from './telegram-alerts.ts';
import {telegramNoticeCapability,validTelegramNoticeInput} from './telegram-notice-provider.ts';

type Options={database:Database;auth:LocalAuthentication;environmentId:string;session:(binding:TelegramBinding)=>TelegramAlertSession;assistantAvailable:(id:string)=>boolean;now?:()=>number};
type Selection={subscription_id:string;binding_digest:string;grant_id:string;token_hash:string;session_id:string;session_revision:number};
export type TelegramNoticeGrantTerms={expiresAt:string;reviewAfter:string};
const denied=():never=>{throw Error('Telegram notice authority unavailable');};
const effect='Send only a fixed, redacted incident notice to this paired subscriber. No incident details, media, memory or arbitrary message text. Separate subscriber consent and incident policy remain required. Logout, revocation, pairing changes, expiry or review deadline stop delivery.';
const digest=capabilityInputDigest;
const command=():AuthorityCommand=>({requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID()});
// Canonical protocol snapshots use UUIDs; the local capability snapshot has a
// stable namespaced string. Preserve both identities in the provider evidence.
function snapshotId(binding:TelegramBinding){const h=digest(['telegram-notice',binding.subscriptionId,binding.revision]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Trusted host adapter over the existing canonical grant lifecycle. It never
 * creates an authenticated session, extends admin idle time or enables a route.
 * Request and approval are separate authenticated Human operations. */
export class TelegramNoticeAuthority {
 private readonly options:Options;private readonly grants:CanonicalGrantRepository;private readonly pairs:TelegramPairingRepository;private readonly now:()=>number;
 constructor(options:Options){this.options=options;this.grants=new CanonicalGrantRepository(options.database,'local-human');this.pairs=new TelegramPairingRepository(options.database);this.now=options.now??Date.now;}
 private time(){return new Date(this.now()).toISOString();}
 private operation(binding:TelegramBinding){return {capabilityId:telegramNoticeCapability.id,capabilityVersion:telegramNoticeCapability.version,operation:'notify',targetRefs:['urn:lifestream:telegram-binding:'+digest(binding)],dataScopeRefs:[]};}
 private check(binding:TelegramBinding,session:TelegramAlertSession,local:LocalContext,administration:boolean){
  this.options.auth.assertCurrent(local,administration);
  if(!local.owner||!binding.alertsEnabled||!this.pairs.current(binding)||!this.options.assistantAvailable(binding.assistantId)||!isDeepStrictEqual(this.options.session(binding),session)||!this.options.database.connection.prepare('SELECT 1 FROM channel_subscriptions s JOIN local_assistant_permissions p ON p.principal_id=s.created_by AND p.assistant_id=s.assistant_id WHERE s.id=? AND s.created_by=? AND p.administer=1').get(binding.subscriptionId,local.principalId))denied();
 }
 private context(binding:TelegramBinding,session:TelegramAlertSession,local:LocalContext,administration:boolean):CanonicalHumanContext{
  return {principalId:local.principalId,providerRef:'local-human',authenticationEvidenceRef:'urn:lifestream:telegram-notice-authentication:'+randomUUID(),now:()=>this.time(),assertCurrent:scope=>{
   this.check(binding,session,local,administration);
   if(scope.assistantId!==binding.assistantId||scope.endpointId!==session.endpointId||scope.environmentId!==this.options.environmentId||(scope.sessionId!==null&&scope.sessionId!==local.sessionId&&(administration||scope.sessionId!==session.sessionId)))denied();
  }};
 }
 request(binding:TelegramBinding,local:LocalContext,terms:TelegramNoticeGrantTerms,mutation=command()):GrantRequest{
  const session=this.options.session(binding);this.check(binding,session,local,true);
  const now=this.now(),expires=Date.parse(terms.expiresAt),review=Date.parse(terms.reviewAfter);
  if(!Number.isFinite(expires)||!Number.isFinite(review)||expires<=now||expires>now+30*86400000||review<=now||review>expires)denied();
  return this.grants.createRequest({scopeDerivation:'validatedArguments',request:{assistantId:binding.assistantId,endpointId:session.endpointId,environmentId:this.options.environmentId,sessionId:local.sessionId,invocationId:randomUUID(),interactionTraceId:randomUUID(),scope:this.operation(binding),inputDigest:digest(this.operation(binding)),effectSummary:effect,sideEffectClass:'irreversible',requestedClass:'allowPersistent',grantExpiresAt:terms.expiresAt,reviewAfter:terms.reviewAfter,expiresAt:new Date(Math.min(now+300000,expires,review)).toISOString(),untrustedRationale:null}},mutation,this.context(binding,session,local,true)).request!;
 }
 approve(binding:TelegramBinding,local:LocalContext,input:{requestId:string;expectedRevision:number;confirmationDigest:string},mutation=command()){
  const session=this.options.session(binding),context=this.context(binding,session,local,true),pending=this.grants.inspectRequest(input.requestId,context);
  if(pending.sessionId!==local.sessionId||pending.requestedClass!=='allowPersistent'||pending.sideEffectClass!=='irreversible'||pending.effectSummary!==effect||!pending.reviewAfter||!isDeepStrictEqual(pending.scope,this.operation(binding)))denied();
  if(pending.state!=='pending'&&this.selection(binding.subscriptionId)?.grant_id!==pending.grantId)denied();
  context.authenticationEvidence={schemaRef:'urn:lifestream:local-authentication-proof:1',data:JSON.stringify({providerRef:'local-password',principalId:local.principalId,assistantId:binding.assistantId,sessionId:local.sessionId,authenticatedAt:new Date(local.authenticatedAt).toISOString(),verifiedAt:context.now()})};
  // Issuance is durable first. If selection fails, the grant stays unselected
  // and cannot dispatch; no authenticated state or route is fabricated.
  const result=this.grants.approveRequest({...input,grantClass:'allowPersistent',expiresAt:pending.grantExpiresAt,reviewAfter:pending.reviewAfter},mutation,context);
  return this.options.database.transaction(()=>{
   this.check(binding,session,local,true);
   this.options.database.connection.prepare('INSERT INTO telegram_notice_authority VALUES(?,?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET binding_digest=excluded.binding_digest,grant_id=excluded.grant_id,token_hash=excluded.token_hash,session_id=excluded.session_id,session_revision=excluded.session_revision').run(binding.subscriptionId,digest(binding),result.grant!.grantId,local.tokenHash,session.sessionId,session.revision);
   return result.grant!;
  });
 }
 cancel(binding:TelegramBinding,local:LocalContext,requestId:string,expectedRevision:number){
  const session=this.options.session(binding),context=this.context(binding,session,local,true),pending=this.grants.inspectRequest(requestId,context);
  if(pending.sessionId!==local.sessionId||!isDeepStrictEqual(pending.scope,this.operation(binding)))denied();
  return this.grants.decideRequest({requestId,expectedRevision,decision:'cancelled'},command(),context).request!;
 }
 revoke(binding:TelegramBinding,local:LocalContext,grantId:string,expectedRevision:number,mutation=command()){
  const session=this.options.session(binding),context=this.context(binding,session,local,true);
  const grant=this.grants.inspectGrant(grantId,context);if(!isDeepStrictEqual(grant.scope,this.operation(binding)))denied();
  return this.grants.revokeGrant({grantId,expectedRevision},mutation,context).grant!;
 }
 inspect(binding:TelegramBinding,local:LocalContext){
  const session=this.options.session(binding);this.check(binding,session,local,true);const row=this.selection(binding.subscriptionId);
  if(!row||row.binding_digest!==digest(binding))return {grant:null,current:false};
  const g=this.grants.inspectGrant(row.grant_id,this.context(binding,session,local,true));
  return {grant:{grantId:g.grantId,revision:g.revision,status:g.status,expiresAt:g.expiresAt,reviewAfter:g.reviewAfter},current:this.authority(binding,session)?.current()??false};
 }
 private selection(id:string){return this.options.database.connection.prepare('SELECT * FROM telegram_notice_authority WHERE subscription_id=?').get(id) as Selection|undefined;}
 private local(row:Selection):LocalContext{
  const s=this.options.database.connection.prepare('SELECT s.*,a.owner FROM local_sessions s JOIN local_accounts a ON s.principal_id=a.principal_id WHERE s.token_hash=?').get(row.token_hash) as {principal_id:string;session_id:string;authenticated_at:number;admin_last_activity:number;origin:string;owner:number}|undefined;
  if(!s)return denied();
  return {principalId:s.principal_id,sessionId:s.session_id,origin:s.origin,owner:!!s.owner,authenticatedAt:s.authenticated_at,tokenHash:row.token_hash,expiresAt:new Date(s.admin_last_activity+AUTH_PARAMETERS.adminIdleMs).toISOString()};
 }
 authority(binding:TelegramBinding,session:TelegramAlertSession):TelegramAlertAuthority|undefined{
  try{
   binding=structuredClone(binding);session=structuredClone(session);
   const row=this.selection(binding.subscriptionId);if(!row||row.binding_digest!==digest(binding)||row.session_id!==session.sessionId||row.session_revision!==session.revision)return;
   const local=this.local(row),context=this.context(binding,session,local,false),grant=this.grants.inspectGrant(row.grant_id,context);
   const scope={assistantId:binding.assistantId,endpointId:session.endpointId,sessionId:session.sessionId,environment:this.options.environmentId,authorityContextRef:{providerRef:'local-human',contextId:grant.grantId,revision:grant.revision}};
   const grantRow=()=>this.options.database.connection.prepare('SELECT payload_json,sha256 FROM canonical_grants WHERE grant_id=?').get(row.grant_id);
   const originalGrantRow=grantRow();
   const current=()=>{try{
    this.check(binding,session,local,false);if(!isDeepStrictEqual(this.selection(binding.subscriptionId),row))return false;
    if(!isDeepStrictEqual(grantRow(),originalGrantRow))return false;
    const selected=grant;
    return selected.status==='active'&&selected.revision===grant.revision&&selected.grantClass==='allowPersistent'&&selected.issuedBy===local.principalId&&selected.sessionId===null&&Date.parse(selected.issuedAt)<=this.now()&&Date.parse(selected.expiresAt)>this.now()&&selected.reviewAfter!==null&&Date.parse(selected.reviewAfter)>this.now()&&isDeepStrictEqual(selected.scope,this.operation(binding));
   }catch{return false;}};
   if(!current())return;
   return {scope,current,dispatch:async(invocation,capability,call)=>{
    const check=(outer=true)=>{
     if(!current()||call.executionMode!=='live'||call.signal.aborted||Date.parse(call.deadlineAt)<=this.now()||(outer&&!call.isCurrent())||!isDeepStrictEqual(capability,telegramNoticeCapability)||!isDeepStrictEqual({assistantId:invocation.assistantId,endpointId:invocation.endpointId,sessionId:invocation.sessionId,environment:invocation.environment,authorityContextRef:invocation.authorityContextRef},scope)||invocation.idempotencyKey!==invocation.invocationId||invocation.capabilityId!==capability.id||invocation.capabilityVersion!==capability.version||invocation.snapshotId!=='telegram-notice:'+binding.subscriptionId||invocation.snapshotRevision!==binding.revision||!validTelegramNoticeInput(invocation,binding,this.now()))denied();
    };
    try{
     check();const operation=this.operation(binding),inputDigest=digest(invocation.input),at=this.time();
     const request:AuthorityRequest={schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:call.requestId,correlationId:call.correlationId,deadlineAt:call.deadlineAt,cancellationId:randomUUID(),executionMode:'normal',scope:{assistantId:binding.assistantId,endpointId:session.endpointId,sessionId:session.sessionId,environmentId:this.options.environmentId,conversationId:null,interactionTraceId:invocation.interactionId,authorityContextRef:scope.authorityContextRef},idempotencyKey:invocation.invocationId,payload:{grantId:grant.grantId,invocationId:invocation.invocationId,scope:operation,inputDigest,snapshotId:snapshotId(binding),snapshotRevision:binding.revision}};
     const evidence=Buffer.from(JSON.stringify({providerRef:'telegram-private',invocationId:invocation.invocationId,inputDigest,scope:operation,snapshotId:invocation.snapshotId,snapshotRevision:binding.revision,bindingDigest:digest(binding),redactedNoticeOnly:true,evaluatedAt:at}));
     const dispatch:AuthorityDispatchRequest={...request,operation:'AuthorityProvider.authorizeDispatch',idempotencyKey:invocation.invocationId,payload:{...request.payload,expectedGrantRevision:grant.revision,requiredProviderDisposition:{decisionId:randomUUID(),providerRef:'telegram-private',invocationId:invocation.invocationId,inputDigest,scopeDigest:digest(operation),authorityContextRef:scope.authorityContextRef,disposition:'authorized',reason:{code:'redacted_notice_scope_valid',summary:'Current paired recipient and fixed redacted notice arguments validated; canonical Human grant required separately.'},evaluatedAt:at,expiresAt:new Date(Math.min(this.now()+10000,Date.parse(call.deadlineAt))).toISOString(),evidenceRef:{reference:'urn:lifestream:telegram-notice-evidence:'+randomUUID(),sha256:createHash('sha256').update(evidence).digest('hex'),byteLength:evidence.byteLength,mediaType:'application/json',schemaRef:'urn:lifestream:telegram-notice-evidence:1'}}}};
     const result=this.grants.authorizeDispatch(dispatch,evidence,context,selected=>evaluateCanonicalGrant(selected,request,{principalId:local.principalId,sessionId:session.sessionId,now:this.time(),authorityContextRef:scope.authorityContextRef,assertCurrent:()=>check(false)}),()=>check(false));
     check();
     if(result.replayed||!this.grants.claimInitialDispatch(invocation.invocationId,result.admission.receipt,context,()=>check(false)))return;
     return {invocationId:invocation.invocationId,status:'admitted',grantRevision:grant.revision};
    }catch{return undefined;}
   }};
  }catch{return undefined;}
 }
}
