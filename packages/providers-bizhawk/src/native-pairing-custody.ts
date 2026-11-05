import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';

/** Trusted in-process host API, never deserialized from configuration/HTTP.
 * Takes ownership of ONE explicitly supplied approved buffer. No entropy, file,
 * account/session API, default approval, reconnect or second backend exists. */
export function createRunScopedNativePairing(input:any){
 if(!(input?.secret instanceof Uint8Array)||input.secret.byteLength!==32||!createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/ActivityScope',input.scope).valid||!/^[a-f0-9]{64}$/.test(input.pinsDigest)||typeof input.approvalRef!=='string'||!input.approvalRef.trim()||input.approvalRef.length>500||typeof input.isCurrent!=='function')throw Error('Explicit approved in-memory pairing required');
 const left=Date.parse(input.expiresAt)-Date.now();if(!Number.isFinite(left)||left<1||left>(input.sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:300000))throw Error('Finite native pairing approval required');
 const scope=structuredClone(input.scope),pins=input.pinsDigest,approvalRef=input.approvalRef,expiresAt=input.expiresAt,isCurrent=input.isCurrent;
 let secret:Buffer|undefined=Buffer.from(input.secret),lastWall=Date.now();input.secret.fill(0);
 const expiresMono=performance.now()+left;
 const close=()=>{clearTimeout(timer);secret?.fill(0);secret=undefined;};
 const timer=setTimeout(close,left);timer.unref();
 const take=async(request:any):Promise<Uint8Array>=>{
  const now=Date.now();
  try{if(now<lastWall||now>=Date.parse(expiresAt)||performance.now()>=expiresMono||isCurrent(scope)!==true){close();throw Error();}lastWall=now;
   if(!secret||request?.signal?.aborted||!isDeepStrictEqual(request?.scope,scope)||request.pinsDigest!==pins||request.approvalRef!==approvalRef||request.expiresAt!==expiresAt)throw Error();
   const result=secret;secret=undefined;clearTimeout(timer);return result;
  }catch{throw Error('Native pairing unavailable for this exact approved run');}
 };
 return Object.freeze({take,close});
}
