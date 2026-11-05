import type {AutonomyScope,ImprovementCandidate} from '@lifestream/contracts';
import {autonomyDigest} from '@lifestream/storage-sqlite';
import type {AutonomyService} from '../runtime/autonomy.ts';
import type {ImprovementWorkshop,WorkshopCandidateSummary} from '../runtime/improvement-workshop.ts';

export type AutonomyAdministration={scope:AutonomyScope;actor:string;current:()=>boolean;service:AutonomyService;workshop:ImprovementWorkshop|null};
function current(host:AutonomyAdministration){if(!host.current())throw Error('autonomy_scope_unavailable');}
function matches(a:ImprovementCandidate|null,b:WorkshopCandidateSummary){return !!a&&a.id===b.id&&a.baseRevision===b.baseRevision&&a.candidateRevision===b.candidateRevision&&a.outcomeDigest===b.outcomeDigest&&a.passed===b.passed;}
export async function inspectAutonomy(host:AutonomyAdministration){
  current(host);const result=host.service.inspect(host.scope),candidates:WorkshopCandidateSummary[]=[];
  // Read only candidates already attached to this exact authorized scope. Never
  // enumerate a shared workshop or initialize its filesystem during inspection.
  if(host.workshop)for(const record of result.improvements){if(!record.candidate)continue;const candidate=await host.workshop.get(record.candidate.id);current(host);if(!candidate||candidate.improvementId!==record.id||!matches(record.candidate,candidate))throw Error('autonomy_candidate_mismatch');candidates.push(candidate);}
  current(host);if(autonomyDigest(host.service.inspect(host.scope).improvements)!==autonomyDigest(result.improvements))throw Error('autonomy_revision_conflict');return {schemaVersion:'1.0.0',...result,reviewOnly:true,automaticExecution:false,resources:null,candidates,workshopConfigured:!!host.workshop};
}
export async function administerAutonomy(host:AutonomyAdministration,value:unknown){
  current(host);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('autonomy_invalid_request');const body=value as Record<string,unknown>;
  const fields=(allowed:string[])=>{if(Object.keys(body).some(key=>!allowed.includes(key))||allowed.some(key=>!(key in body)))throw Error('autonomy_invalid_request');};
  host.service.inspect(host.scope);const repository=host.service.repository;
  if(body.operation==='decide'){
    fields(['operation','id','expectedRevision','decision','note']);
    if(!['reject','defer'].includes(String(body.decision)))throw Error('autonomy_review_only');
    if(typeof body.id!=='string'||!Number.isSafeInteger(body.expectedRevision)||typeof body.note!=='string')throw Error('autonomy_invalid_request');
    current(host);repository.decide(host.scope,body.id,body.expectedRevision as number,body.decision as 'reject'|'defer',host.actor,body.note);
  }else if(body.operation==='review'){
    fields(['operation','id']);if(typeof body.id!=='string'||!host.workshop)throw Error('autonomy_workshop_unavailable');
    const record=repository.get(host.scope,body.id);if(!record?.candidate)throw Error('autonomy_candidate_unavailable');
    const candidateReview=await host.workshop.review(record.candidate.id);current(host);
    const latest=repository.get(host.scope,body.id);
    if(!latest||latest.revision!==record.revision||candidateReview.candidate.improvementId!==record.id||!matches(latest.candidate,candidateReview.candidate))throw Error('autonomy_candidate_mismatch');
    const inspected=await inspectAutonomy(host);current(host);if(repository.get(host.scope,body.id)?.revision!==record.revision)throw Error('autonomy_revision_conflict');
    return {...inspected,candidateReview};
  }else throw Error('autonomy_review_only');
  return inspectAutonomy(host);
}
