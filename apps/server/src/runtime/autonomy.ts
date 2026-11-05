import type {AutonomyScope,AutonomyEvidenceReference} from '@lifestream/contracts';
import {AutonomyRepository,type Database} from '@lifestream/storage-sqlite';

/** Original S104 retained projection, without recovery, evidence reconciliation,
 * timers, sources, provider, scheduler or workshop execution capabilities. */
export class AutonomyService {
  readonly reviewOnly=true;
  readonly repository:AutonomyRepository;
  constructor(database:Database,private readonly current:(scope:AutonomyScope)=>boolean,private readonly evidenceCurrent:(scope:AutonomyScope,reference:AutonomyEvidenceReference)=>boolean=()=>false){this.repository=new AutonomyRepository(database);}
  inspect(scope:AutonomyScope){
    if(!this.current(scope))throw Error('autonomy_scope_unavailable');
    const records=this.repository.list(scope);if(records.some(record=>record.proposal.evidenceRefs.some(ref=>!this.evidenceCurrent(scope,ref))))throw Error('autonomy_evidence_unavailable');
    return {settings:this.repository.read(scope),improvements:this.repository.list(scope),jobs:this.repository.jobs(scope),briefing:this.repository.briefing(scope),preparedBriefing:this.repository.preparedBriefing(scope),budget:this.repository.budget(scope)};
  }
}
