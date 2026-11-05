import {assertCompatibleSchema,RECOVERY_MODE} from './schema74-compatibility.mjs';
// Scoped metadata only. No username, credential/hash, persona/profile body,
// conversation text, memory content, source context or media body is selected.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readOwnershipMetadata(databasePath){
 const db=new DatabaseSync(databasePath,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON');
  const all=(sql)=>db.prepare(sql).all();
  const accounts=all('SELECT principal_id,owner,disabled,epoch FROM local_accounts ORDER BY principal_id');
  const profiles=all("SELECT assistant_id,profile_id,revision,status,json_extract(profile_json,'$.voiceProfile') AS voice_ref,json_extract(profile_json,'$.presentationProfile') AS presentation_ref FROM assistant_profiles WHERE status='active' ORDER BY assistant_id,profile_id");
  const permissions=all('SELECT principal_id,assistant_id,administer FROM local_assistant_permissions ORDER BY principal_id,assistant_id');
  const presentation=all('SELECT principal_id,endpoint_id,scope_id,package_id,package_digest,revision FROM presentation_selections ORDER BY principal_id,endpoint_id,scope_id');
  const policies=all('SELECT principal_id,assistant_id,relationship_id,enabled,revision FROM automatic_memory_policies ORDER BY principal_id,assistant_id,relationship_id');
  const memories=all("SELECT id,assistant_id,json_extract(provenance_json,'$.actor') AS actor,json_extract(lifecycle_json,'$.revision') AS revision,json_extract(lifecycle_json,'$.status') AS status FROM memories ORDER BY id");
  const tables=all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_catalog','conversation_timeline') ORDER BY name");
  const timeline=tables.some(x=>x.name==='conversation_timeline')?db.prepare("SELECT COUNT(*) AS count FROM conversation_timeline WHERE content_state='retained'").get().count:0;
  return Object.freeze({schemaVersion:'ownership-metadata:1.0.0',
   accounts:{count:accounts.length,enabledOwnerCount:accounts.filter(x=>x.owner===1&&x.disabled===0).length,digest:digest(accounts)},
   profiles:{activeCount:profiles.length,nullVoiceReferenceCount:profiles.filter(x=>x.voice_ref===null).length,nullPresentationReferenceCount:profiles.filter(x=>x.presentation_ref===null).length,digest:digest(profiles)},
   permissions:{count:permissions.length,digest:digest(permissions)},
   presentation:{selectedRows:presentation.length,digest:digest(presentation)},
   automaticMemory:{policyCount:policies.length,enabledPolicyCount:policies.filter(x=>x.enabled===1).length,digest:digest(policies)},
   memoryStore:{rowCount:memories.length,metadataDigest:digest(memories)},
   history:{durableTableCount:tables.length,retainedBodyCount:Number(timeline)},
   highestMigration:Number(db.prepare('SELECT MAX(id) AS id FROM schema_migrations').get().id),
   privateBodiesRead:false,credentialFieldsRead:false});
 }finally{db.close();}
}
export function assertOwnershipPreserved(actual,expected,{afterMigration=false}={}){
 assert.equal(actual.schemaVersion,expected.schemaVersion);
 for(const section of ['accounts','profiles','permissions','presentation','automaticMemory'])assert.deepEqual(actual[section],expected[section],`Original ownership metadata changed: ${section}`);
 // The original independent forgetting owners may reconcile stale memory rows.
 // They must never be overwritten merely to restore a previous metadata count.
 if(!afterMigration)assert.deepEqual(actual.memoryStore,expected.memoryStore,'Consistent source-memory adoption required');
 assert.equal(actual.history.retainedBodyCount,expected.history.retainedBodyCount,'History retention cannot be introduced by backfill');
 if(afterMigration)assert.equal(actual.highestMigration,74,'This closure requires its exact registered migration74');
 else assert.equal(actual.highestMigration,expected.highestMigration);
 return true;
}
export function providerBindingMetadata(config){
 return Object.freeze({schemaVersion:'provider-binding:1.0.0',profile:config.profile,
  providersDigest:digest(config.providers),requirementsDigest:digest(config.providerRequirements??{}),
  inferenceDigest:digest(config.inferenceProfile??null),sttDigest:digest(config.sttProfile??null),ttsDigest:digest(config.ttsProfile??null),
  savedVoiceConfigurationDigest:digest({provider:config.providers.tts,profile:config.ttsProfile??null}),
  embeddedCredentialsAccepted:false});
}
export function adoptionPhase(marker,stateDirectory,databasePath){
 assert.ok(marker,'Historical native-daily adoption is required');
 assert.equal(marker.schemaVersion,'daily-adoption:1.0.0');assert.equal(marker.familyId,'native-daily');assert.equal(marker.stateDirectory,stateDirectory);assert.equal(marker.schemaCeiling,73,'Preserve the original historical family marker');
 return {phase:'restart',...assertCompatibleSchema(databasePath,{allow73:!RECOVERY_MODE})};
}
