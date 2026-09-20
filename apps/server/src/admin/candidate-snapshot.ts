import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {backup,DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {mkdir,realpath,lstat,readdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {join,dirname,resolve,sep} from 'node:path';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {LocalAuthentication} from '../auth/local-auth.ts';
import {RelationshipRecovery} from './relationship-recovery.ts';
import {quarantineRestoredExperience} from './experience-recovery.ts';
import {PresentationPackages} from './presentation-packages.ts';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
type Artifact={path:string;bytes:number;sha256:string};
type Manifest={schemaVersion:'1.0.0';kind:'lifestream.candidate-snapshot';snapshotId:string;createdAt:string;files:Artifact[];safetyEpoch:number;packageCount:number};
export async function outsideGit(path:string):Promise<string>{const canonical=await realpath(path);for(let p=canonical;;p=dirname(p)){if(existsSync(join(p,'.git')))throw Error('Private recovery paths must be outside Git');if(dirname(p)===p)break;}return canonical;}
async function fresh(path:string){await mkdir(dirname(resolve(path)),{recursive:true,mode:0o700});await outsideGit(dirname(resolve(path)));await mkdir(path,{mode:0o700});return outsideGit(path);}
async function files(directory:string,prefix=''):Promise<Artifact[]>{if(prefix.split('/').length>32)throw Error('Recovery path nesting exceeds supported bounds');const result:Artifact[]=[];for(const name of (await readdir(join(directory,prefix))).sort()){const path=prefix?prefix+'/'+name:name;if(path.split('/').some(p=>p==='..'||p==='.'||p==='.git'))throw Error('Unsafe recovery path');const full=join(directory,path),info=await lstat(full);if(info.isSymbolicLink())throw Error('Recovery paths cannot contain symbolic links');if(info.isDirectory())result.push(...await files(directory,path));else{if(!info.isFile()||info.size>192*1024*1024)throw Error('Recovery file exceeds supported bounds');const bytes=await readFile(full);result.push({path,bytes:bytes.length,sha256:hash(bytes)});}if(result.length>20000)throw Error('Recovery inventory exceeds supported bounds');}return result;}
async function copyInventory(source:string,target:string,inventory:Artifact[]){for(const file of inventory){if(!file.path||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='..'||p==='.')||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>192*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid recovery manifest');const input=join(source,file.path),output=join(target,file.path),info=await lstat(input);if(info.isSymbolicLink()||!info.isFile())throw Error('Recovery file changed');const canonical=await realpath(input);if(!canonical.startsWith(source+sep))throw Error('Recovery file escaped custody');await mkdir(dirname(output),{recursive:true,mode:0o700});await copyFile(input,output);const bytes=await readFile(output);if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw Error('Recovery bytes differ from manifest');}}
async function safety(directory:string){const entries=await files(directory);if(entries.reduce((sum,f)=>sum+f.bytes,0)>32*1024*1024)throw Error('Safety state exceeds supported bounds');return entries;}
function catalog(directory:string){const packages=new PresentationPackages({directory,ownerPrincipalId:'snapshot'});if(packages.failures.length)throw Error('A presentation package failed validation');return packages.list('snapshot');}
function unavailableSelections(db:DatabaseSync,directory:string){const packages=catalog(directory);return db.prepare("SELECT package_id AS id,package_digest AS digest FROM presentation_selections WHERE scope_id='default'").all().filter(row=>!(row.id==='neutral'&&row.digest==='neutral-v1')&&!packages.some(p=>p.id===row.id&&p.digest===row.digest)).length;}

function separate(target:string,sources:string[]){if(sources.some(source=>target===source||target.startsWith(source+sep)))throw Error('Recovery destination must be separate from source');}

/** Application-owned, consistent SQLite export. The encrypted repository is composition-owned. */
export async function snapshotCandidate(input:{candidate:string;packages:string;destination:string}):Promise<Manifest>{
 const candidate=await outsideGit(input.candidate),packages=await outsideGit(input.packages);separate(resolve(input.destination),[candidate,packages]);const target=await fresh(input.destination);
 try{separate(target,[candidate,packages]);}catch(error){await rm(target,{recursive:true,force:true});throw error;}
 try{
  const before=await safety(join(candidate,'safety')),database=new DatabaseSync(join(candidate,'data.sqlite'),{readOnly:true});try{await backup(database,join(target,'data.sqlite'));}finally{database.close();}
  await copyInventory(join(candidate,'safety'),join(target,'safety'),before);if(JSON.stringify(before)!==JSON.stringify(await safety(join(candidate,'safety'))))throw Error('Safety state changed during snapshot; retry from a new snapshot directory');
  const entries=catalog(packages),count=entries.length,declared=new Set(['index.json',...entries.flatMap(p=>[p.id+'/manifest.json',...p.manifest.resources.map(r=>p.id+'/'+r.path)])]);
  const packageFiles:Artifact[]=[];for(const path of [...declared].sort()){const full=join(packages,path),info=await lstat(full);if(info.isSymbolicLink()||!info.isFile()||info.size>192*1024*1024)throw Error('Invalid package resource');const bytes=await readFile(full);packageFiles.push({path,bytes:bytes.length,sha256:hash(bytes)});}
  await copyInventory(packages,join(target,'packages'),packageFiles);if(catalog(join(target,'packages')).length!==count)throw Error('Presentation inventory changed');
  await copyFile(join(candidate,'candidate.json'),join(target,'candidate.json'));
  const db=new DatabaseSync(join(target,'data.sqlite'),{readOnly:true});let epoch:number;try{if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('Snapshot SQLite integrity failed');epoch=Number(db.prepare('SELECT epoch FROM relationship_recovery_currency WHERE singleton=1').get()?.epoch??0);}finally{db.close();}
  await rm(join(target,'data.sqlite-shm'),{force:true});await rm(join(target,'data.sqlite-wal'),{force:true});
  const journal=JSON.parse(await readFile(join(target,'safety/relationship-recovery/journal.json'),'utf8'));if(journal.epoch<epoch)throw Error('Snapshot safety currency is stale');
  const manifest:Manifest={schemaVersion:'1.0.0',kind:'lifestream.candidate-snapshot',snapshotId:randomUUID(),createdAt:new Date().toISOString(),files:await files(target),safetyEpoch:journal.epoch,packageCount:count};await writeFile(join(target,'snapshot-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});return manifest;
 }catch(error){await rm(target,{recursive:true,force:true});throw error;}
}
/** Restores only into a new isolated path. Current safety state is mandatory. */
export async function restoreCandidate(input:{snapshot:string;currentSafety:string;destination:string}){
 const snapshot=await outsideGit(input.snapshot),currentSafety=await outsideGit(input.currentSafety),manifest=JSON.parse(await readFile(join(snapshot,'snapshot-manifest.json'),'utf8')) as Manifest;
 if(manifest.schemaVersion!=='1.0.0'||manifest.kind!=='lifestream.candidate-snapshot'||!Array.isArray(manifest.files)||manifest.files.length>20000||!Number.isSafeInteger(manifest.safetyEpoch)||manifest.safetyEpoch<0||!Number.isInteger(manifest.packageCount)||manifest.packageCount<0||manifest.packageCount>16||!/^[a-f0-9-]{36}$/.test(manifest.snapshotId)||manifest.files.some(f=>!['data.sqlite','candidate.json'].includes(f.path)&&!f.path.startsWith('packages/')&&!f.path.startsWith('safety/'))||new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length)throw Error('Invalid candidate snapshot');
 const current=await safety(currentSafety),retained=manifest.files.filter(f=>f.path.startsWith('safety/')).map(f=>({...f,path:f.path.slice(7)})),byPath=new Map(current.map(f=>[f.path,f]));
 for(const old of retained){const now=byPath.get(old.path);if(!now)throw Error('Current safety state is incomplete');if(old.path==='relationship-recovery/journal.json')continue;if(old.path.startsWith('epoch-')){const oldEpoch=Number(await readFile(join(snapshot,'safety',old.path),'utf8')),currentEpoch=Number(await readFile(join(currentSafety,old.path),'utf8'));if(!Number.isSafeInteger(oldEpoch)||!Number.isSafeInteger(currentEpoch)||currentEpoch<oldEpoch)throw Error('Authentication safety epoch is stale');continue;}if(now.sha256!==old.sha256)throw Error('Safety history changed identity');}
 const journal=JSON.parse(await readFile(join(currentSafety,'relationship-recovery/journal.json'),'utf8')),oldJournal=JSON.parse(await readFile(join(snapshot,'safety/relationship-recovery/journal.json'),'utf8'));
 if(!Array.isArray(journal.intents)||!Array.isArray(oldJournal.intents)||oldJournal.epoch!==manifest.safetyEpoch||journal.epoch<manifest.safetyEpoch||JSON.stringify(journal.intents.slice(0,oldJournal.epoch))!==JSON.stringify(oldJournal.intents))throw Error('Current forgetting journal is older or belongs to another history');
 separate(resolve(input.destination),[snapshot,currentSafety]);const target=await fresh(input.destination);
 try{separate(target,[snapshot,currentSafety]);}catch(error){await rm(target,{recursive:true,force:true});throw error;}
 try{
  await copyInventory(snapshot,target,manifest.files);await rm(join(target,'safety'),{recursive:true,force:true});await copyInventory(currentSafety,join(target,'safety'),current);if(JSON.stringify(current)!==JSON.stringify(await safety(currentSafety)))throw Error('Safety changed during restore; retry');
  let unavailableDefaultPresentations=0,experientialLearning={scopes:0,retainedScopes:0,cancelledJobs:0};const db=new Database({path:join(target,'data.sqlite')});try{
   db.migrate();new LocalAuthentication(db,{stateDirectory:join(target,'safety')});const memories=new MemoryRepository(db),recovery=new RelationshipRecovery(db,memories,join(target,'safety/relationship-recovery'));if(recovery.journal.currency!=='current')throw Error('Restored privacy state cannot prove current currency');recovery.recover();
   const epoch=Number(db.connection.prepare('SELECT epoch FROM relationship_recovery_currency WHERE singleton=1').get()?.epoch);if(epoch!==recovery.journal.revision)throw Error('Restored privacy replay is incomplete');
   experientialLearning=quarantineRestoredExperience(db,memories,recovery);
   db.transaction(tx=>{tx.run('UPDATE local_sessions SET revoked=1');tx.run("UPDATE sessions SET status='closed',endpoint_id=NULL,revision=revision+1");tx.run('DELETE FROM prepared_context');tx.run("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,reason='restore_quarantine' WHERE state IN ('queued','running','prepared','failed')");tx.run('UPDATE automatic_memory_policies SET enabled=0,revision=revision+1');tx.run("DELETE FROM presentation_selections WHERE scope_id<>'default'");});
   unavailableDefaultPresentations=unavailableSelections(db.connection,join(target,'packages'));
   if(db.connection.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('Restored database integrity failed');
  }finally{db.close();}
  if(catalog(join(target,'packages')).length!==manifest.packageCount)throw Error('Restored presentation package count differs');
  const receipt={schemaVersion:'1.0.0',status:'verified',snapshotId:manifest.snapshotId,restoredAt:new Date().toISOString(),safetyEpoch:journal.epoch,packageCount:manifest.packageCount,unavailableDefaultPresentations,authority:'quarantined',sessions:'revoked',audience:'unknown',automaticMemory:'requiresFreshScopeApproval',experientialLearning:{...experientialLearning,status:'disabledAndFrozen',approval:'freshMemoryAndLearningApprovalRequired'},humanAcceptance:false};
  await writeFile(join(target,'restore-quarantine.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});await writeFile(join(target,'installer-token.txt'),randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});return receipt;
 }catch(error){await rm(target,{recursive:true,force:true});throw error;}
}
