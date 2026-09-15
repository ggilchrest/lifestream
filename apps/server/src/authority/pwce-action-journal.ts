import {randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {join} from 'node:path';
import {Database,loadMigrations} from '@lifestream/storage-sqlite';
import type {PwceAdmissionCustody,PwceInvocationCustody} from '@lifestream/providers-pwce';
import {SqlitePwceAdmissionCustody} from './pwce-admission-custody.ts';
import {SqlitePwceInvocationCustody} from './pwce-invocation-custody.ts';

const fail=():never=>{throw new Error('pwce_action_journal_unavailable');};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function regular(path:string):Stats{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail();return stat;}
function directory(path:string):Stats{const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail();return stat;}
function same(a:Stats,b:Stats):boolean{return a.ino===b.ino&&a.dev===b.dev;}
function syncDirectory(path:string):void{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function exclusive(path:string,value:string):void{
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}
}
function identityBytes(path:string):string{
 const stat=regular(path);if(stat.size>1024||stat.size===0)fail();
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{if(!same(stat,fstatSync(fd)))fail();const bytes=readFileSync(fd);if(bytes.length>1024||bytes.length!==stat.size)fail();return bytes.toString('utf8');}finally{closeSync(fd);}
}
export interface PwceActionJournalOptions {
 /** Existing local authentication/safety directory, outside application backups. */
 stateDirectory:string;
 deploymentId:string;
 /** Only first provisioning. Existing or partially lost journals are never reset. */
 create?:boolean;
 capacity?:number;
}

/** Consumer attempt custody. This never grants authority or repairs uncertain history. */
export class PwceActionJournal {
 readonly admissions:PwceAdmissionCustody;
 readonly invocations:PwceInvocationCustody;
 private readonly database:Database;
 private readonly root:string;
 private readonly path:string;
 private readonly anchor:string;
 private readonly seal:string;
 private readonly bytes:string;
 private readonly rootStat:Stats;
 private readonly directoryStat:Stats;
 private readonly databaseStat:Stats;
 private readonly walStat:Stats;
 private readonly shmStat:Stats;
 private closed=false;
 private fenced=false;
 constructor(options:PwceActionJournalOptions){
  let database:Database|undefined;
  try{
   if(!uuid.test(options.deploymentId))fail();
   if(options.capacity!==undefined&&(!Number.isSafeInteger(options.capacity)||options.capacity<1||options.capacity>4096))fail();
   directory(options.stateDirectory);this.root=realpathSync(options.stateDirectory);this.rootStat=directory(this.root);
   this.anchor=join(this.root,'pwce-journal-identity.json');const dir=join(this.root,'pwce-action-journal');
   this.path=join(dir,'custody.sqlite');this.seal=join(dir,'identity.json');
   const migrations=loadMigrations().filter(item=>item.id===36||item.id===37);if(migrations.length!==2)fail();
   let fresh=false;
   if(!existsSync(this.anchor)){
    // The exclusive anchor arbitrates simultaneous provisioning. A partial
    // initializer leaves a visible fence; no later open may fill its gaps.
    if(!options.create||existsSync(dir))fail();
    const bytes=JSON.stringify({schemaVersion:'1.0.0',deploymentId:options.deploymentId,journalId:randomUUID()});
    exclusive(this.anchor,bytes);syncDirectory(this.root);
    mkdirSync(dir,{mode:0o700});syncDirectory(this.root);
    exclusive(this.path,'');syncDirectory(dir);fresh=true;
   }
   this.bytes=identityBytes(this.anchor);const identity=JSON.parse(this.bytes) as Record<string,unknown>;
   if(Object.keys(identity).sort().join(',')!=='deploymentId,journalId,schemaVersion'||identity.schemaVersion!=='1.0.0'||identity.deploymentId!==options.deploymentId||typeof identity.journalId!=='string'||!uuid.test(identity.journalId))fail();
   this.directoryStat=directory(dir);this.databaseStat=regular(this.path);
   if(!fresh&&identityBytes(this.seal)!==this.bytes)fail();
   this.checkSidecars();
   database=new Database({path:this.path,migrations});
   // FULL makes each committed claim durable in WAL before a caller can send.
   // The shared application Database defaults to NORMAL; never inherit that.
   database.exec('PRAGMA synchronous = FULL');
   if(fresh){
    database.migrate();
    database.transaction(tx=>{
     tx.run('CREATE TABLE pwce_journal_identity (identity TEXT NOT NULL)');
     tx.run('INSERT INTO pwce_journal_identity VALUES (?)',this.bytes);
    });
    exclusive(this.seal,this.bytes);syncDirectory(dir);
   }
   // Reopening never runs migrations that could recreate missing history.
   const rows=database.connection.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all();
   if(JSON.stringify(rows)!==JSON.stringify(migrations.map(({id,name,digest})=>({id,name,digest}))))fail();
   const ids=database.connection.prepare('SELECT identity FROM pwce_journal_identity').all();
   if(ids.length!==1||ids[0]?.identity!==this.bytes)fail();
   const check=database.connection.prepare('PRAGMA quick_check').all();
   if(check.length!==1||check[0]?.quick_check!=='ok')fail();
   for(const table of ['pwce_admission_custody','pwce_invocation_custody','pwce_invocation_observations'])database.connection.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
   this.walStat=regular(this.path+'-wal');this.shmStat=regular(this.path+'-shm');
   this.database=database;this.assertCurrent();
   const admissions=new SqlitePwceAdmissionCustody(database,options.capacity),invocations=new SqlitePwceInvocationCustody(database,options.capacity);
   this.admissions=Object.freeze({
    read:key=>this.guarded(()=>admissions.read(key)),
    reserve:intent=>this.guarded(()=>admissions.reserve(intent)),
    complete:(key,outcome)=>this.guarded(()=>admissions.complete(key,outcome))
   } satisfies PwceAdmissionCustody);
   this.invocations=Object.freeze({
    read:id=>this.guarded(()=>invocations.read(id)),
    claim:request=>this.guarded(()=>invocations.claim(request)),
    observe:(id,observation)=>this.guarded(()=>invocations.observe(id,observation)),
    readObservation:(id,reference)=>this.guarded(()=>invocations.readObservation(id,reference))
   } satisfies PwceInvocationCustody);
  }catch{try{database?.close();}catch{/* Keep initialization failure. */}throw new Error('pwce_action_journal_unavailable');}
 }
 private checkSidecars():void{
  for(const suffix of ['-wal','-shm','-journal']){
   const path=this.path+suffix;
   // lstat detects dangling symlinks too; existsSync alone would miss them.
   try{regular(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
 }
 assertCurrent():void{
  try{
   if(this.closed||this.fenced)fail();
   if(!same(this.rootStat,directory(this.root))||!same(this.directoryStat,directory(join(this.root,'pwce-action-journal')))||!same(this.databaseStat,regular(this.path)))fail();
   if(!same(this.walStat,regular(this.path+'-wal'))||!same(this.shmStat,regular(this.path+'-shm')))fail();
   if(identityBytes(this.anchor)!==this.bytes||identityBytes(this.seal)!==this.bytes)fail();
   this.checkSidecars();
   const sync=this.database.connection.prepare('PRAGMA synchronous').get();if(sync?.synchronous!==2)fail();
  }catch{this.fenced=true;fail();}
 }
 private guarded<T>(operation:()=>T):T{this.assertCurrent();try{return operation();}finally{this.assertCurrent();}}
 close():void{if(this.closed)return;this.closed=true;this.database.close();}
}
