import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';

/** Private run-scoped presentation only. Neither snapshots nor explanations
 * authorize input, claim visual progress, or change canonical accounting. */
export function createGameActivityFeed(runId:string){
 type Event={sequence:number;at:string;kind:'decision'|'outcome';decisionId:string;proposalId?:string;actionId?:string;state:'proposed'|'executed'|'rejected'|'cancelled'|'failed'|'noAction'|'unconfirmed';reasonCode?:string;message:string;explanation?:string;expected?:string;uncertainty?:string};
 const phases={ready:'Ready to play.',starting:'Starting the game.',observing:'Reading the current game image.',thinking:'Choosing the next action.',validating:'Checking the current scene before input.',acting:'Applying a bounded input.',stopped:'Game session stopped.'} as const;
 let terminalMessage:string|null=null;let sequence=0,phase:keyof typeof phases='ready';const entries:Event[]=[],decisions=new Map<string,string>();
 const text=(value:unknown)=>typeof value==='string'?value.slice(0,240):'';
 const append=(event:Omit<Event,'sequence'|'at'>)=>{entries.push({...event,sequence:++sequence,at:new Date().toISOString()});if(entries.length>32)entries.shift();};
 return Object.freeze({
  failure(value:{phase?:string;reason?:string}){if(terminalMessage||value.reason==='adapter_cancelled')return;if(value.reason==='provider_inference_unavailable'){terminalMessage='Game stopped because the decision provider was unavailable.';return;}const labels:Record<string,string>={'prepare-planning':'preparing the next decision','run-planning':'requesting the next decision','select-planning':'reading the current game image','prepare-controller':'checking the proposed input','run-controller':'applying the proposed input','record-settlement':'recording the input outcome'};const label=value.phase&&labels[value.phase];if(label)terminalMessage='Game stopped while '+label+'.';},
  phase(value:keyof typeof phases){if(Object.hasOwn(phases,value))phase=value;},
  decision(raw:G.GameActionProposal|null,decisionId?:string){
   const proposal=boundedGameDataSnapshot(raw,16384) as G.GameActionProposal|null;
   if(proposal===null){if(decisionId&&/^[a-f0-9-]{36}$/.test(decisionId))append({kind:'decision',decisionId,state:'noAction',message:'No action proposed.'});return;}
   if(!proposal||proposal.scope?.runId!==runId||!Array.isArray(proposal.buttons)||proposal.buttons.some(b=>!['up','down','left','right','a','b','x','y','l','r','start','select'].includes(b))||!Number.isSafeInteger(proposal.durationFrames)||proposal.durationFrames<1||proposal.durationFrames>120)return;
   const id=decisionId??proposal.proposalId;if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||typeof proposal.proposalId!=='string')return;decisions.set(proposal.proposalId,id);if(decisions.size>32)decisions.delete(decisions.keys().next().value!);
   append({kind:'decision',decisionId:id,proposalId:proposal.proposalId,state:'proposed',message:`Proposed ${proposal.buttons.length?proposal.buttons.join(' + '):'neutral input'} for ${proposal.durationFrames} frames (up to ${proposal.maxWallMs} ms).`,explanation:text(proposal.reason),expected:text(proposal.expectedVisibleOutcome),uncertainty:text(proposal.uncertainty)});
  },
  outcome(raw:G.GameActionReceipt){
   const receipt=boundedGameDataSnapshot(raw,16384) as G.GameActionReceipt|null;
   if(!receipt||receipt.scope?.runId!==runId||receipt.buttonsNeutralized!==true||!['completed','cancelled','failed'].includes(receipt.disposition)||!Number.isSafeInteger(receipt.framesApplied)||receipt.framesApplied===null||receipt.framesApplied<0)return;
   const id=decisions.get(receipt.proposalId);if(!id)return;
   append({kind:'outcome',decisionId:id,proposalId:receipt.proposalId,actionId:receipt.actionId,state:receipt.disposition==='completed'?'executed':receipt.disposition as 'cancelled'|'failed',message:`Input ${receipt.disposition}: ${receipt.framesApplied} frames applied; controls neutralized.`});
  },
  rejected(proposalId:string,reason?:string){
   const labels:Record<string,string>={ordinary_target_not_current:'the original owned game target was no longer current',planning_scene_unavailable:'the prior image interpretation was unavailable',current_scene_unavailable:'the fresh image interpretation was unavailable',scene_interpreter_changed:'the image interpreter changed',scene_comparison_changed:'the image comparison reported a changed scene',scene_comparison_unknown:'the image comparison was uncertain',scene_comparison_missing:'the images were not compared',scene_reference_changed:'the comparison referred to a different observation',scene_kind_changed:'the image classification changed the action context',scene_comparison_not_confirmed:'the image comparison did not confirm the action context',prepared_proposal_invalid:'the proposal no longer matched its prepared context',scene_comparison_not_current:'the scene comparison was no longer current',observation_identity_invalid:'the fresh observation identity was invalid',observation_lineage_or_expiry:'the observation lineage or lifetime was invalid',observation_revision_changed:'the observation revision changed',diagnostic_image_changed:'the diagnostic image changed',observation_provenance_invalid:'the fresh observation provenance was invalid',precondition_changed_or_expired:'a proposed precondition changed or expired',dispatch_currentness_lost:'the current game context was withdrawn',dispatch_validation_error:'fresh input validation was unavailable'};
   const id=decisions.get(proposalId),code=typeof reason==='string'&&Object.hasOwn(labels,reason)?reason:undefined;if(id)append({kind:'outcome',decisionId:id,proposalId,state:'rejected',...(code?{reasonCode:code}:{}),message:code?'Proposed input rejected because '+labels[code]+'; no execution confirmed.':'Proposed input rejected by current scene or controller validation; no execution confirmed.'});
  },
  unconfirmed(){const proposal=[...entries].reverse().find(entry=>entry.kind==='decision'&&entry.state==='proposed'&&!entries.some(outcome=>outcome.kind==='outcome'&&outcome.decisionId===entry.decisionId));if(!proposal)return;append({kind:'outcome',decisionId:proposal.decisionId,...(proposal.proposalId?{proposalId:proposal.proposalId}:{}),state:'unconfirmed',message:'Input outcome unconfirmed; reservation retained. No replay authorized.'});terminalMessage??='Game stopped: an input outcome requires reconciliation.';},
  snapshot(){return {runId,phase,message:phase==='stopped'&&terminalMessage?terminalMessage:phases[phase],entries:entries.map(entry=>({...entry}))};},
 });
}
