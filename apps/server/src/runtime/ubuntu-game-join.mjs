import {WindowsGameHostClient} from '../../../../packages/providers-bizhawk/src/game-host-client.ts';
import {createSupervisedGameRuntime} from '../../../../scripts/supervised-game-runtime.mjs';

/** Source composition for an Ubuntu host. Existing client class name is legacy;
 * it supplies the established HTTP/admission protocol without OS input itself.
 * Caller owns the real authenticated session, native pairing/evidence, campaign
 * and inference qualification. This module creates none of those authorities.
 */
export class UbuntuGameJoinUnavailable extends Error {
 constructor(missing){super('Ubuntu game join needs existing trusted ports: '+missing.join(', '));this.name='UbuntuGameJoinUnavailable';this.missing=Object.freeze(missing);}
}
const requiredClient=['fetchAuthenticated','isScopeCurrent','sourceIsQualified','openNative','shutdownExactOldLease'];
const requiredNative=['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor','shutdownExactOldLease'];
const requiredCampaign=['selectPlanning','planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'];
export function missingUbuntuGameJoinPorts(input){
 const missing=[];
 for(const key of requiredClient)if(typeof input?.client?.[key]!=='function')missing.push('client.'+key);
 for(const key of requiredNative)if(typeof input?.composition?.native?.[key]!=='function')missing.push('composition.native.'+key);
 for(const key of requiredCampaign)if(typeof input?.composition?.campaign?.[key]!=='function')missing.push('composition.campaign.'+key);
 for(const key of ['createRepository','resolveApproval','inferenceQualificationFor'])if(typeof input?.composition?.[key]!=='function')missing.push('composition.'+key);
 if(!input?.client?.attach)missing.push('client.attach (actual authenticated G/Tifa/game binding)');
 if(!input?.client?.nativeBoundary)missing.push('client.nativeBoundary (qualified source/frame/action/old-lease evidence)');
 return Object.freeze(missing);
}
/** Wait for this captured client's result acknowledgement to settle. Broker
 * completion resolves the server observation first; that alone is not proof
 * that the original client has released its active command. No new deadline or
 * grant is introduced: source/transport custody and cancellation still govern. */
export async function waitForGameClientQuiescence(client,signal,current){
 while(!signal.aborted&&current()===true){
  const snapshot=client.snapshot;if(snapshot.fenced||!snapshot.attached)return false;
  if(snapshot.activeCommandId===null)return true;
  await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,1);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
 }
 return false;
}
/** Prepare only. Install returned serverOptions on the same existing server
 * instance before the authenticated broker calls runClient(). No background
 * start, credential discovery, fixture authority, alternate model or retries.
 */
export function createUbuntuGameHostJoin(input){
 const missing=missingUbuntuGameJoinPorts(input);
 if(missing.length)throw new UbuntuGameJoinUnavailable(missing);
 const client=new WindowsGameHostClient(input.client);
 let composition;
 try{composition=createSupervisedGameRuntime({...input.composition,onRetire:()=>client.close()});}catch(error){client.close();throw error;}
 let started=false,stopping;
 return Object.freeze({
  serverOptions:Object.freeze({gameHost:composition.gameHost,gameRuntime:composition.gameRuntime}),
  clientSnapshot:()=>client.snapshot,
  waitForClientQuiescence:signal=>waitForGameClientQuiescence(client,signal,composition.current),
  current:()=>composition.current(),
  async runClient(){if(started)throw new Error('Ubuntu game client already started');started=true;return client.run();},
  clientReady:()=>client.ready,
  completion:()=>composition.completion(),
  stop(){return stopping??=Promise.resolve().then(()=>composition.stop()).finally(()=>client.close());}
 });
}
