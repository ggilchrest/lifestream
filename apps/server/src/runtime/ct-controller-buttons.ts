import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {GameActionProposal,GameActionRequest} from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter,GameCallContext} from '@lifestream/providers-bizhawk';

const buttons=Object.freeze(['up','down','left','right','a','b','x','y','l','r','start','select']);
/** Trusted supervised profile restriction; never a wire/config override. */
export const supervisedCtNoStartPolicy=Object.freeze({revision:'supervised8-no-snes-start/1',allowedButtons:Object.freeze(buttons.filter(button=>button!=='start'))});
const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export function captureSupervisedCtProposal(raw:unknown):GameActionProposal|null{
 const proposal=boundedGameDataSnapshot(raw) as GameActionProposal|null;
 if(!proposal||!Array.isArray(proposal.buttons)||proposal.buttons.length>supervisedCtNoStartPolicy.allowedButtons.length||new Set(proposal.buttons).size!==proposal.buttons.length||proposal.buttons.some(button=>!supervisedCtNoStartPolicy.allowedButtons.includes(button)))return null;
 return freeze(proposal);
}

export function captureSupervisedCtControllerRequest(raw:unknown):GameActionRequest|null{
 const request=boundedGameDataSnapshot(raw) as GameActionRequest|null;
 if(!request||request.operation!=='GameActivityAdapter.applyController'||!request.payload)return null;
 const proposal=captureSupervisedCtProposal(request.payload.proposal),vector=request.payload.buttonVector;
 if(!proposal||!vector||Object.keys(vector).sort().join(',')!==[...buttons].sort().join(',')||buttons.some(button=>typeof (vector as any)[button]!=='boolean'||(vector as any)[button]!==proposal.buttons.includes(button as GameActionProposal['buttons'][number])))return null;
 request.payload.proposal=proposal;
 return freeze(request);
}

/** Wrap only the final adapter opened by the trusted supervised server owner.
 * This restriction adds no authority; the original adapter and all of its
 * admission/source/budget checks still run for every allowed request. */
export function ctControllerAdapterForProfile(profile:unknown,adapter:GameActivityAdapter):GameActivityAdapter{
 if(profile!=='supervised8')return adapter;
 return Object.freeze({...adapter,applyController:async(request:GameActionRequest,context:GameCallContext)=>{
  const captured=captureSupervisedCtControllerRequest(request);
  if(!captured)throw Error('ct_supervised_controller_buttons_denied');
  return adapter.applyController(captured,context);
 }});
}
