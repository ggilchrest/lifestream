import {AuthenticationError,type LocalContext,type LocalAuthentication} from '../auth/local-auth.ts';
import type {GameHostActor} from './game-host-port.ts';
/** Receives the actual existing authenticated/CSRF-checked actor and local
 * context from Main. Identity fields come from that producing authentication
 * owner, never HTTP fields, an operator JSON principal or an assumed self flag. */
export function nativeObservationActor(base:GameHostActor,context:LocalContext,authentication:LocalAuthentication){
 const effective=context.effectiveContext;
 if(!effective||typeof context.contextRef!=='string'||!context.contextRef||effective.actorId!==context.principalId||effective.effectiveUserId!==context.principalId||effective.authenticatedSessionId!==context.sessionId)throw new AuthenticationError(403,'native_observation_scope_denied');
 authentication.assertCurrent(context,true);
 if(base.principalId!==context.principalId||base.sessionId!==context.sessionId||authentication.effectiveUser(context)!==context.principalId)throw new AuthenticationError(403,'native_observation_scope_denied');
 const current=(scope:Parameters<GameHostActor['isCurrent']>[0])=>{try{authentication.assertCurrent(context,false);return authentication.effectiveUser(context)===context.principalId&&base.isCurrent(scope);}catch{return false;}};
 return Object.freeze({principalId:context.principalId,actorId:context.principalId,effectiveUserId:authentication.effectiveUser(context),sessionId:context.sessionId,isCurrent:current});
}
