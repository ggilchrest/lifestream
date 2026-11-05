import type {ServerResponse} from 'node:http';
import {AuthenticationError} from '../auth/local-auth.ts';

/** Compatibility only. Call after authenticating/currentness checks; this marker
 * neither authenticates the caller nor grants a stream slot. HTTP204 terminates
 * an old EventSource instead of asking it to reconnect indefinitely. */
export function admitAuthorityStream(response:ServerResponse,query:URLSearchParams,urgent=false):boolean {
 const allowed=urgent?['assistantId','transport']:['transport'];
 if([...query.keys()].some(key=>!allowed.includes(key))||query.getAll('transport').length>1||query.has('transport')&&query.get('transport')!=='shared-v1'||urgent&&query.getAll('assistantId').length!==1)throw new AuthenticationError(422,'authority_transport_invalid_query');
 if(query.get('transport')==='shared-v1')return true;
 response.writeHead(204,{'cache-control':'no-store','x-lifestream-transport':'upgrade-required'});response.end();return false;
}
export function audienceTransportOwner(identity:{principalId:string;sessionId:string;endpointId:string|null}) {
 return {principalId:identity.principalId,authenticatedSessionId:identity.sessionId,endpointId:identity.endpointId};
}
