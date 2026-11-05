import {AuthenticationError,type LocalAuthentication,type LocalContext} from '../auth/local-auth.ts';
import type {Database} from '@lifestream/storage-sqlite';
import type {GameHostActor} from './game-host-port.ts';
import {readSessionEndpoint} from './session-context.ts';

/** Request-local binding from the original authentication/CSRF owner. Capture
 * before reading a body; never resolve a later user's context/selection for an
 * earlier request. The original host actor retains audience/relationship/runtime
 * policy. No HTTP fields can supply identity, metadata, grants or a runtime. */
export function bindGameplayRequest(auth:LocalAuthentication,raw:LocalContext,reference:unknown,base:GameHostActor,database:Database){
 const local=auth.bindContext(raw,reference),effective=local.effectiveContext;
 auth.assertCurrent(local,true);
 if(!effective||!local.contextRef||effective.actorId!==local.principalId||effective.effectiveUserId!==local.principalId||effective.authenticatedSessionId!==local.sessionId||base.principalId!==local.principalId||base.sessionId!==local.sessionId)throw new AuthenticationError(403,'game_session_scope_denied');
 const selection=()=>{
  const session=database.readGet("SELECT conversation_id,endpoint_id,revision FROM sessions WHERE id=? AND status='active'",local.sessionId),selected=readSessionEndpoint(database,local.sessionId),endpoint=selected.endpoint;
  const registered=endpoint&&database.readGet('SELECT configuration_revision,endpoint_class,ownership,health,profile_json FROM interaction_endpoints WHERE endpoint_id=?',endpoint.endpointId);
  const conversation=session&&database.readGet('SELECT assistant_id,effective_user_id FROM conversation_catalog WHERE conversation_id=?',String(session.conversation_id));
  const owned=endpoint&&!!database.readGet('SELECT 1 FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?',local.principalId,endpoint.endpointId);
  return JSON.stringify([session,selected,registered,conversation,owned]);
 };
 const originalSelection=selection();
 const assertCurrent=(administration=true)=>{
  auth.assertCurrent(local,administration);
  if(selection()!==originalSelection)throw new AuthenticationError(409,'game_session_selection_changed');
 };
 const current:GameHostActor['isCurrent']=scope=>{try{assertCurrent(false);return base.isCurrent(scope);}catch{return false;}};
 const actor=Object.freeze({...base,principalId:local.principalId,sessionId:local.sessionId,actorId:effective.actorId,effectiveUserId:effective.effectiveUserId,effectiveContext:effective,contextRef:local.contextRef,isCurrent:current,...(base.runtimeFor?{runtimeFor:((scope,repository)=>current(scope)?base.runtimeFor!(scope,repository):null) as NonNullable<GameHostActor['runtimeFor']>}:{})});
 return Object.freeze({local,actor,assertCurrent});
}
