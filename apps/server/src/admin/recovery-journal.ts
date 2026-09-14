import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import type {Database} from '@lifestream/storage-sqlite';
export const privacyActions=['stop-collection','revoke-processing','stop-personalization','prohibit-training','delete-source','forget-derived-information'] as const;
export type PrivacyAction=typeof privacyActions[number];
export type RecoveryIntent={operationId:string;idempotencyKey:string;requestDigest:string;rootRecordIds:string[];rootMemoryIds:string[];rootProfileIds:string[];actor:string;assistantId:string;relationshipId:string;action:PrivacyAction;recordIds:string[];memoryIds:string[];profileIds:string[];sourceDigests:string[];contentDigests:string[];createdAt:string};
export const recoveryDigest=(s:string)=>createHash('sha256').update(s.trim().replace(/\s+/gu,' ')).digest('hex');
type Journal={schemaVersion:'1.0.0';epoch:number;intents:RecoveryIntent[]};
/** Payload-free owner-local safety state outside database backups. No worker can grant use. */
export class RecoveryJournal {
 private state:Journal={schemaVersion:'1.0.0',epoch:0,intents:[]};private directory:string|undefined;readonly currency:'current'|'unknown';
 constructor(db:Database,directory?:string){this.directory=directory;db.exec('CREATE TABLE IF NOT EXISTS relationship_recovery_currency (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL)');const marker=db.connection.prepare('SELECT epoch FROM relationship_recovery_currency WHERE singleton=1').get() as {epoch:number}|undefined;
  if(!directory){this.currency='current';db.connection.prepare('INSERT OR IGNORE INTO relationship_recovery_currency VALUES (1,0)').run();return;}
  mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,'journal.json');let current=true;
  if(existsSync(path)){try{if(statSync(path).size>8388608)throw new Error('Safety journal capacity exceeded');const value=JSON.parse(readFileSync(path,'utf8')) as Journal;if(value.schemaVersion!=='1.0.0'||!Number.isSafeInteger(value.epoch)||value.epoch<0||!Array.isArray(value.intents)||value.intents.length!==value.epoch||value.intents.length>10000||value.intents.some(i=>!privacyActions.includes(i.action)||[i.operationId,i.idempotencyKey,i.actor,i.assistantId,i.relationshipId,i.createdAt,i.requestDigest].some(v=>typeof v!=='string'||!v||v.length>256)||[i.recordIds,i.memoryIds,i.profileIds,i.rootRecordIds,i.rootMemoryIds,i.rootProfileIds,i.sourceDigests,i.contentDigests].some(a=>!Array.isArray(a)||a.length>8192||a.some(v=>typeof v!=='string'||v.length>256))))throw new Error('Invalid safety journal');this.state=value;if(marker&&marker.epoch>value.epoch)current=false;}catch{current=false;}}
  else if(marker||Number((db.connection.prepare('SELECT ((SELECT COUNT(*) FROM assistant_relationships)+(SELECT COUNT(*) FROM memories)+(SELECT COUNT(*) FROM user_profile_revisions)) AS n').get() as {n:number}).n)>0)current=false;
  else this.write(this.state);
  this.currency=current?'current':'unknown';if(current)db.connection.prepare('INSERT OR IGNORE INTO relationship_recovery_currency VALUES (1,0)').run();
 }
 private write(state:Journal){const payload=JSON.stringify(state);if(Buffer.byteLength(payload)>8388608)throw new Error('Safety journal capacity exceeded; retain current tombstones');if(!this.directory)return;const temporary=join(this.directory,`pending-${randomUUID()}`),fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,payload);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,join(this.directory,'journal.json'));const directory=openSync(this.directory,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
 get revision():number{return this.state.epoch;}
 snapshot():Journal{return structuredClone(this.state);}
 admit(intent:RecoveryIntent):RecoveryIntent{if(this.currency!=='current')throw new Error('Recovery currency unknown; affected stored state requires current safety evidence');const prior=this.state.intents.find(i=>i.idempotencyKey===intent.idempotencyKey);if(prior){if(JSON.stringify({...prior,operationId:'',createdAt:''})!==JSON.stringify({...intent,operationId:'',createdAt:''}))throw new Error('Privacy idempotency conflict');return structuredClone(prior);}if(this.state.intents.length>=10000)throw new Error('Safety journal capacity reached; retain current tombstones and review storage');const state={...this.state,epoch:this.state.epoch+1,intents:[...this.state.intents,structuredClone(intent)]};this.write(state);this.state=state;return structuredClone(intent);}
 known(key:string,actor:string,relationshipId:string):RecoveryIntent|undefined{return this.state.intents.find(i=>i.idempotencyKey===key&&i.actor===actor&&i.relationshipId===relationshipId);}
 forbidden(actor:string,relationshipId:string,value:string,sourceDigest?:string):boolean{const digest=recoveryDigest(value);return this.currency!=='current'||this.state.intents.some(i=>i.actor===actor&&i.relationshipId===relationshipId&&['delete-source','forget-derived-information','revoke-processing'].includes(i.action)&&(i.contentDigests.includes(digest)||!!sourceDigest&&i.sourceDigests.includes(sourceDigest)));}
}
