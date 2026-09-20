import {createHash} from 'node:crypto';
import type {Database} from '@lifestream/storage-sqlite';
import {readSessionEndpoint} from './session-context.ts';

type Definition={schemaVersion:'1.0.0';mode:'text'|'audio';audienceScope:'unknown'|'authenticatedSession'};
export class SessionDefinitionError extends Error {readonly status:422|409;constructor(status:422|409,message:string){super(message);this.status=status;}}
export function inspectSessionDefinition(database:Database,sessionId:string){
 const session=readSessionEndpoint(database,sessionId);
 const definition:Definition={schemaVersion:'1.0.0',mode:session.endpoint?.inputModalities.includes('audio')?'audio':'text',audienceScope:session.endpoint?.privacyClass==='personal'?'authenticatedSession':'unknown'};
 return {definition,sessionRevision:session.revision,endpointId:session.endpoint?.endpointId??null,limitations:['Only this sign-in changes; other sign-ins and endpoint defaults remain independent.','Audio mode negotiates transport without starting capture or playback.','Disclosure is still constrained by current audience and approved memory scope.','Identity, persona, voice, appearance, tools and physical-device bindings use their existing separate owners.']};
}
export function reviewSessionDefinition(input:{database:Database;sessionId:string;principalId:string;audioConfigured:boolean;boundary:string;body:Record<string,unknown>}){
 const {body}=input,applying=body.operation==='apply';
 if(typeof body.operation!=='string'||!['preview','apply'].includes(body.operation)||Object.keys(body).some(k=>!(applying?['operation','definition','expectedRevision','reviewDigest']:['operation','definition','expectedRevision']).includes(k))||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0)throw new SessionDefinitionError(422,'A supported operation and current session revision are required.');
 const raw=body.definition as Record<string,unknown>|null;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['schemaVersion','mode','audienceScope'].includes(k))||raw.schemaVersion!=='1.0.0'||typeof raw.mode!=='string'||!['text','audio'].includes(raw.mode)||typeof raw.audienceScope!=='string'||!['unknown','authenticatedSession'].includes(raw.audienceScope))throw new SessionDefinitionError(422,'Use only schemaVersion 1.0.0, text/audio mode and unknown/authenticatedSession audienceScope.');
 const definition:Definition={schemaVersion:'1.0.0',mode:raw.mode as Definition['mode'],audienceScope:raw.audienceScope as Definition['audienceScope']};
 const current=inspectSessionDefinition(input.database,input.sessionId);
 if(!current.endpointId||current.sessionRevision!==body.expectedRevision)throw new SessionDefinitionError(409,'Session changed or is unbound. Load current settings and review again.');
 if(definition.mode==='audio'&&!input.audioConfigured)throw new SessionDefinitionError(409,'Audio transport is not configured. No settings were changed.');
 // This is a revision fence for authorized administration, never an authority grant.
 const reviewDigest=createHash('sha256').update(JSON.stringify([input.principalId,input.sessionId,current.endpointId,current.sessionRevision,input.boundary,definition])).digest('hex');
 if(applying&&body.reviewDigest!==reviewDigest)throw new SessionDefinitionError(409,'The definition or runtime scope changed. Preview the current definition before applying.');
 const changes=(['mode','audienceScope'] as const).filter(field=>current.definition[field]!==definition[field]).map(field=>({field,before:current.definition[field],after:definition[field]}));
 return {...current,definition,changes,reviewDigest,applyBehavior:'Explicit apply revises this session atomically and fences affected pending input/output; it does not open a microphone or renderer.'};
}
