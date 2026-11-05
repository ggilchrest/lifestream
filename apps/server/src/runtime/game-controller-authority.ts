import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CanonicalGrantRepository} from '@lifestream/storage-sqlite';
import {evaluateCanonicalGrant} from '@lifestream/runtime/authority/grants';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {captureSupervisedCtProposal,supervisedCtNoStartPolicy} from './ct-controller-buttons.ts';

const digest=(value:any)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** First-party adapter for the pinned simulated-game run. A CURRENT existing
 * canonical grant is mandatory; Start consent does not issue or widen a grant. */
export function createGameControllerAuthority(configuration:any,session:any,testBoundary?:any){
 if(configuration.sessionLifetime!==undefined&&configuration.sessionLifetime!=='sessionScoped')throw Error('Ordinary controller session scope required');
 const maximumGrantMs=configuration.maximumGrantMs??120000;
 if(!Number.isSafeInteger(maximumGrantMs)||maximumGrantMs<1||maximumGrantMs>(configuration.sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:300000))throw Error('Finite reviewed controller permission lifetime required');
 const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 const scope=freeze(structuredClone(configuration.scope)),bounds=freeze(structuredClone(configuration.bounds)),pinsDigest=configuration.pinsDigest;let grantId=configuration.grantId,pending:any,preparation:any;
 const supervised=configuration.sessionProfile==='supervised8';
 // Reflect this owner's already pinned restrictions. Reading this metadata never
 // evaluates a grant, creates a review, or admits a controller effect.
 const actionProposalConstraints=freeze({allowedButtons:supervised?supervisedCtNoStartPolicy.allowedButtons:['up','down','left','right','a','b','x','y','l','r','start','select'],maxDurationFrames:bounds.maxActionFrames,maxWallMs:Math.min(bounds.maxActionWallMs,bounds.maxInputLeaseMs),grantsAuthority:false});
 const planningConstraintsFor=(candidate:any)=>{try{return isDeepStrictEqual(candidate,scope)&&(typeof session.preparationCurrent==='function'?session.preparationCurrent(scope):session.current(scope))===true?actionProposalConstraints:null;}catch{return null;}};
 const reviewInput=freeze({scope:structuredClone(scope),pinsDigest,bounds:structuredClone(bounds),policyRevision:configuration.policyRevision,...(maximumGrantMs!==120000?{maximumGrantMs}:{}),...(supervised?{controllerPolicy:supervisedCtNoStartPolicy}:{})});
 const operation=freeze({capabilityId:'game.ct-controller',capabilityVersion:'1.0.0',operation:'applyController',targetRefs:['urn:lifestream:ct-run:'+digest({scope,pinsDigest,bounds,...(maximumGrantMs!==120000?{maximumGrantMs}:{}),...(supervised?{controllerPolicy:supervisedCtNoStartPolicy}:{})})],dataScopeRefs:[]});
 const repositoryFor=(owner:any)=>testBoundary?.repository??new CanonicalGrantRepository(owner.database,'local-human');
 const assertCurrent=(binding:any,principalId?:string)=>{const owner=session.authorityOwner();if(!owner||principalId&&principalId!==scope.principalId||binding.assistantId!==scope.assistantId||binding.endpointId!==scope.contextBinding.endpointId||binding.environmentId!==scope.environmentId||binding.sessionId!==scope.contextBinding.sessionId)throw Error('Game controller permission scope changed');owner.context.assertCurrent(binding);};
 const host={environmentId:scope.environmentId,assertCurrent,assertProposalCurrent:(request:any,principalId:string)=>{assertCurrent(request,principalId);if(!isDeepStrictEqual(request.scope,operation)||request.requestedClass!=='allowSession')throw Error('Game grant proposal changed');},resolveProposal:async()=>{throw Error('Use authenticated configured game permission review');}};
 // An intent describes the original terms without creating a request or grant.
 // Only unused pending/expired records may return here. Legacy review() also
 // handles other states; the dedicated preparation bridge must never use that
 // behavior to undo a denial, cancellation, approval or revocation.
 const preparationIntent=()=>{
  const owner=session.authorityOwner();if(!owner||grantId)throw Error('Unused game controller preparation required');
  assertCurrent({assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId,sessionId:scope.contextBinding.sessionId});
  if(pending){
   const record=repositoryFor(owner).inspectRequest(pending.requestId,owner.context);
   if(!['pending','expired'].includes(record.state)||record.grantId||!preparation||!isDeepStrictEqual(Object.fromEntries(Object.keys(preparation.request).map(key=>[key,record[key]])),preparation.request))throw Error('Game controller preparation is no longer unused');
  }
  return freeze({termsDigest:digest(reviewInput),operationDigest:digest(operation),grantClass:'allowSession',maximumGrantMs});
 };
 const review=()=>{
  const owner=session.authorityOwner();if(!owner)throw Error('Authenticated game permission review required');
  assertCurrent({assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId,sessionId:scope.contextBinding.sessionId});
  const repository=repositoryFor(owner);if(pending){
   const old=repository.inspectRequest(pending.requestId,owner.context);
   if(old.state==='pending'&&Date.parse(old.expiresAt)>Date.now())return old;
   if(old.state==='approved'&&old.grantId){try{const grant=repository.inspectGrant(old.grantId,owner.context);if(grant.status==='active'&&Date.parse(grant.expiresAt)>Date.now())return old;}catch{/* An explicit fresh review below creates pending metadata only. */}}
   pending=undefined;preparation=undefined;grantId=undefined;
  }
  const now=Date.now(),expiresAt=new Date(now+maximumGrantMs).toISOString();
  preparation=freeze({scopeDerivation:'validatedArguments',request:{assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId,sessionId:scope.contextBinding.sessionId,invocationId:randomUUID(),interactionTraceId:randomUUID(),scope:operation,inputDigest:digest(operation),effectSummary:`Use the owned CT controller in this exact run for at most ${bounds.actionBudget} actions, ${Math.min(bounds.frameBudget,bounds.actionBudget*bounds.maxActionFrames)} controlled frames and ${bounds.wallBudgetMs} ms total. Each action is bounded to ${bounds.maxActionFrames} frames and ${bounds.maxActionWallMs} ms; the run allows at most ${bounds.modelCallBudget} model decisions. No saves, resets, account access or other applications.${supervised?' The SNES Start button is forbidden; starting the run is a separate one-use operation.':''}`,sideEffectClass:'reversible',requestedClass:'allowSession',grantExpiresAt:expiresAt,reviewAfter:null,expiresAt,untrustedRationale:null}});
  pending=repository.createRequest(preparation,{requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID()},owner.context).request;
  return pending;
 };
 // Retain only this owner's actual reviewed run terms, never a generic tool
 // invocation or an executable controller action. Reading cannot issue a grant.
 const ownsPreparation=(invocationId:string)=>!!pending&&pending.invocationId===invocationId;
 const inspectPreparation=(invocationId:string)=>{
  const owner=session.authorityOwner();if(!owner||!preparation||!ownsPreparation(invocationId))throw Error('Game controller preparation unavailable');
  const check=()=>assertCurrent(preparation.request,owner.context.principalId);check();
  const record=repositoryFor(owner).inspectRequest(pending.requestId,owner.context);
  if(!['pending','approved'].includes(record.state)||Date.parse(record.expiresAt)<=Date.now()||!isDeepStrictEqual(Object.fromEntries(Object.keys(preparation.request).map(key=>[key,record[key]])),preparation.request))throw Error('Game controller preparation changed');
  check();
  return freeze({executionOwner:'ctSession',permissionRequestId:record.requestId,preparation:structuredClone(preparation),input:structuredClone(reviewInput),grantsAuthority:false,dispatchStarted:false});
 };
 session.setPermissionReview?.(review);
 let qualifiedGrantUntil=0;
 const canStart=()=>{
  try{
   const owner=session.authorityOwner();if(!owner)return false;
   const repository=repositoryFor(owner),selectedId=grantId??(pending?repository.inspectRequest(pending.requestId,owner.context).grantId:null);if(!selectedId)return false;
   // inspectGrant freshly authenticates this exact original binding and rejoins
   // the canonical row after that callback. Everything below is synchronous,
   // local evaluation of the captured grant and request, not another source read.
   let selectedUntil=0;
   const qualified=repository.inspectGrantWith(selectedId,owner.context,(grant:any)=>{
   const binding={assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId,sessionId:scope.contextBinding.sessionId};
   const matches=(value:any)=>Object.entries(binding).every(([key,expected])=>value[key]===expected);
   if(owner.context.principalId!==scope.principalId||!matches(grant)||grant.grantClass!=='allowSession'||!isDeepStrictEqual(grant.scope,operation)||Date.parse(grant.expiresAt)-Date.parse(grant.issuedAt)>maximumGrantMs)return false;
   const authorityContextRef={providerRef:'local-human',contextId:grant.grantId,revision:grant.revision},now=new Date().toISOString();
   const request={schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:grant.expiresAt,cancellationId:randomUUID(),executionMode:'normal',scope:{...binding,conversationId:scope.contextBinding.conversationId,interactionTraceId:randomUUID(),authorityContextRef},idempotencyKey:randomUUID(),payload:{grantId:selectedId,invocationId:randomUUID(),scope:operation,inputDigest:digest({purpose:'ctStart',scope,pinsDigest,bounds}),snapshotId:scope.runId,snapshotRevision:scope.timelineRevision}};
   const result=evaluateCanonicalGrant(grant,request as any,{principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,now,authorityContextRef,assertCurrent:value=>{if(!matches(value)||!matches(grant)||owner.context.principalId!==scope.principalId)throw Error('Game controller permission scope changed');}});
   // The original guard may synchronously withdraw the session. Requalify its
   // owner after the canonical read, and enforce expiry after all callbacks.
   const after=session.authorityOwner();
   if(result.disposition!=='authorized'||!after||after.context!==owner.context||after.database!==owner.database||Date.now()>=Date.parse(grant.expiresAt))return false;
   selectedUntil=Date.parse(grant.expiresAt);return true;
   });
   if(qualified){grantId=selectedId;qualifiedGrantUntil=selectedUntil;}return qualified;
  }catch{return false;}
 };
 session.setControllerStartCheck?.(canStart);
 return Object.freeze({operation,host,review,canStart,currentGrantExpiresAt:()=>canStart()?qualifiedGrantUntil:null,planningConstraintsFor,ownsPreparation,inspectPreparation,preparationIntent,
  async requestFor(join:any,result:any,dispatch:any,observation:any,signal:AbortSignal){
   try{
   const proposal=supervised?captureSupervisedCtProposal(result.proposal):result.proposal;
   if(!proposal)return null;
   const owner=session.authorityOwner();
   const domain=observation.visibleState?.find((field:any)=>field.fieldId==='ct.ui.controller-domain');
   const reviewedDomain=!!domain&&domain.value==='ordinaryGameplay'&&domain.visibility==='visibleNow'&&domain.lastObservedRef===observation.observationId&&Date.parse(domain.freshUntil)>Date.now();
   const ownedPlayTarget=typeof configuration.playTargetCurrent==='function'&&configuration.playTargetCurrent(scope,observation)===true;
   if(!reviewedDomain&&!ownedPlayTarget)return null;
   if(!grantId&&owner&&pending)grantId=repositoryFor(owner).inspectRequest(pending.requestId,owner.context).grantId;
   if(!owner||!grantId||!proposal||signal.aborted||!session.current(scope)||!join.runtime?.controllerCurrent()||!isDeepStrictEqual(proposal.scope,scope)||proposal.buttons.some((b:string)=>!['up','down','left','right','a','b','x','y','l','r','start','select'].includes(b))||proposal.durationFrames<1||proposal.durationFrames>bounds.maxActionFrames||proposal.maxWallMs<1||proposal.maxWallMs>bounds.maxActionWallMs)return null;
   const repository=repositoryFor(owner);
   const grant=repository.inspectGrant(grantId,owner.context);
   // A processing target is not an admission lease. Use only the original
   // finite run/grant/observation and configured command-lifetime bounds; never
   // renew an issued request or widen the separately bounded native input.
   const approval=session.resolveApproval?.(scope),runUntil=Date.parse(approval?.approvedUntil??''),commandMs=configuration.maximumCommandMs;
   if(!Number.isFinite(runUntil)||runUntil<=Date.now()||!Number.isSafeInteger(commandMs)||commandMs<1||commandMs>120000)return null;
   const invocationId=randomUUID(),idempotencyKey=randomUUID(),inputOwnerLeaseId=randomUUID(),at=new Date().toISOString(),deadline=new Date(Math.min(runUntil,Date.now()+commandMs,Date.parse(dispatch.preparedContextFreshUntil),Date.parse(grant.expiresAt))).toISOString();
   const input={scope,pinsDigest,proposal,dispatch,inputOwnerLeaseId,expectedFrameNumber:observation.frameNumber},inputDigest=digest(input);
   const authorityContextRef={providerRef:'local-human',contextId:grant.grantId,revision:grant.revision};
   const check=()=>{if(signal.aborted||!session.current(scope)||!join.runtime.controllerCurrent())throw Error('Game authority scope withdrawn');owner.context.assertCurrent({assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId,sessionId:scope.contextBinding.sessionId});};
   check();
   const request={schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:deadline,cancellationId:randomUUID(),executionMode:'normal',scope:{assistantId:scope.assistantId,endpointId:scope.contextBinding.endpointId,sessionId:scope.contextBinding.sessionId,environmentId:scope.environmentId,conversationId:scope.contextBinding.conversationId,interactionTraceId:invocationId,authorityContextRef},idempotencyKey,payload:{grantId,invocationId,scope:operation,inputDigest,snapshotId:scope.runId,snapshotRevision:scope.timelineRevision}};
   const evidence=Buffer.from(JSON.stringify({providerRef:'bizhawk-owned-ubuntu',invocationId,inputDigest,scope:operation,sourcePins:pinsDigest,runId:scope.runId,frame:observation.frameNumber,boundedController:true,evaluatedAt:at}));
   const disposition={decisionId:randomUUID(),providerRef:'bizhawk-owned-ubuntu',invocationId,inputDigest,scopeDigest:digest(operation),authorityContextRef,disposition:'authorized',reason:{code:'owned_game_controller_bounds_valid',summary:'Pinned simulated-game run and finite controller arguments validated; independent canonical Human grant required.'},evaluatedAt:at,expiresAt:deadline,evidenceRef:{reference:'urn:lifestream:game-provider-evidence:'+invocationId,sha256:createHash('sha256').update(evidence).digest('hex'),byteLength:evidence.length,mediaType:'application/json',schemaRef:'urn:lifestream:game-provider-evidence:1'}};
   const admitted=repository.authorizeDispatch({...request,operation:'AuthorityProvider.authorizeDispatch',payload:{...request.payload,expectedGrantRevision:grant.revision,requiredProviderDisposition:disposition}},evidence,owner.context,(selected:any)=>evaluateCanonicalGrant(selected,request as any,{principalId:owner.context.principalId,sessionId:scope.contextBinding.sessionId,now:new Date().toISOString(),authorityContextRef,assertCurrent:check}),check);
   check();if(admitted.replayed||!repository.claimInitialDispatch(invocationId,admitted.admission.receipt,owner.context,check))return null;
   const decision=admitted.admission.decision;
   const buttons=Object.fromEntries(['up','down','left','right','a','b','x','y','l','r','start','select'].map(button=>[button,proposal.buttons.includes(button)]));
   return {schemaVersion:'1.0.0',operation:'GameActivityAdapter.applyController',requestId:randomUUID(),correlationId:request.correlationId,deadlineAt:deadline,cancellationId:request.cancellationId,executionMode:'normal',scope,idempotencyKey,payload:{actionId:randomUUID(),proposal,admission:{admissionId:decision.decisionId,capabilityInvocationId:invocationId,authorityContextRef,dispatchReceipt:admitted.admission.receipt,scopeDigest:decision.scopeDigest,inputDigest,policyRevision:configuration.policyRevision,issuedAt:decision.admittedAt,expiresAt:deadline},inputOwnerLeaseId,buttonVector:buttons,protectedMenuOperation:'none',expectedFrameNumber:observation.frameNumber,expectedPinsDigest:pinsDigest,dispatchValidation:dispatch}};
   }catch(error){testBoundary?.trace?.(error);throw error;}
  }
 });
}
