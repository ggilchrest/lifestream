import {createHash} from 'node:crypto';
import {ExperienceRepository,type Database,type MemoryRepository} from '@lifestream/storage-sqlite';
import type {ExperienceScope,ExperiencePolicy} from '@lifestream/contracts/experience';
import {retainedExperienceSources} from '../runtime/experience-inputs.ts';
import type {RelationshipRecovery,RecoveryRelationship} from './relationship-recovery.ts';
const key=(scope:ExperienceScope)=>createHash('sha256').update(JSON.stringify([scope.principalId,scope.assistantId,scope.relationshipId])).digest('hex');

/** Retention suspension only. Never grants processing, selection, collection or effects.
 * A subsequent memory-policy edit invalidates it, including an explicit disable. */
export function experienceRetentionSuspended(db:Database,scope:ExperienceScope,memoryRevision:number):boolean{
 return !!db.connection.prepare('SELECT 1 FROM experience_restore_quarantine WHERE scope_key=? AND memory_policy_revision=?').get(key(scope),memoryRevision);
}

/** Replay has already applied current safety. Scrub dependent payloads before exposing
 * the restored directory, then freeze learning and cancel/fence every old job. */
export function quarantineRestoredExperience(db:Database,memories:MemoryRepository,recovery:RelationshipRecovery){
 const repo=new ExperienceRepository(db);let scopes=0,retainedScopes=0,cancelledJobs=0;
 // Recovery covers the entire stored inventory, not the runtime worker's 256-scope batch.
 for(const row of db.connection.prepare('SELECT scope_json FROM experience_state').all()){
  const scope=JSON.parse(String(row.scope_json)) as ExperienceScope,scopeKey=key(scope),state=repo.read(scope);
  const memory=db.connection.prepare('SELECT enabled,revision FROM automatic_memory_policies WHERE scope_key=?').get(scopeKey);
  const stored=db.connection.prepare('SELECT payload_json FROM assistant_relationships WHERE relationship_id=? AND assistant_id=? AND user_id=?').get(scope.relationshipId,scope.assistantId,scope.principalId);
  const relationship=stored?JSON.parse(String(stored.payload_json)) as RecoveryRelationship:undefined;
  const eligible=!!relationship&&relationship.status==='active'&&!relationship.collectionStopped&&!recovery.pending(relationship)&&recovery.journal.currency==='current'&&!!db.connection.prepare('SELECT 1 FROM local_accounts a JOIN local_assistant_permissions p ON a.principal_id=p.principal_id WHERE a.principal_id=? AND a.disabled=0 AND p.assistant_id=? AND p.administer=1').get(scope.principalId,scope.assistantId);
  const retained=!!memory&&(!!memory.enabled||experienceRetentionSuspended(db,scope,Number(memory.revision)))&&eligible;
  const policy:ExperiencePolicy={allowed:retained,revision:state.configuration.processingPolicyRevision,dimensions:{}};
  const sources=retainedExperienceSources(memories,scope,content=>eligible&&!recovery.journal.forbidden(scope.principalId,scope.relationshipId,content));
  cancelledJobs+=Number(db.connection.prepare("SELECT count(*) AS n FROM experience_jobs WHERE scope_key=? AND json_extract(payload_json,'$.state') IN ('queued','running')").get(scopeKey)!.n);
  repo.reconcile(scope,sources,policy);
  const reconciled=repo.read(scope);repo.configure(scope,reconciled.revision,{enabled:false,frozen:true,retention:'sourceBound',topicPolicies:reconciled.configuration.topicPolicies},policy);
  // The enclosing restore increments every memory policy once while disabling it.
  if(retained){db.connection.prepare('INSERT OR REPLACE INTO experience_restore_quarantine VALUES (?,?)').run(scopeKey,Number(memory!.revision)+1);retainedScopes++;}
  else db.connection.prepare('DELETE FROM experience_restore_quarantine WHERE scope_key=?').run(scopeKey);
  scopes++;
 }
 return {scopes,retainedScopes,cancelledJobs};
}
