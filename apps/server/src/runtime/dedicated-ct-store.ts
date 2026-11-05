import {Database} from '@lifestream/storage-sqlite';
import {lstatSync,mkdirSync,openSync,closeSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export type DedicatedCtStore=Readonly<{database:Database;directory:string;close:()=>void}>;
const stores=new WeakMap<DedicatedCtStore,{identity:Database;closed:boolean;device:number;inode:number;directoryInode:number}>();
/** New empty activity/authority metadata only. Never copies account, profile,
 * session, credential or conversation rows from the original identity owner. */
export function createDedicatedCtStore(directory:string,identity:Database):DedicatedCtStore{
 if(resolve(directory)!==directory||!/^\/srv\/lifestream\/workspace\/runtime-state\/ct-isolated-metadata-[A-Za-z0-9-]+$/.test(directory)||realpathSync(dirname(directory))!==dirname(directory))throw Error('ct_metadata_directory_invalid');
 const parent=lstatSync(dirname(directory));if(!parent.isDirectory()||parent.uid!==process.getuid?.())throw Error('ct_metadata_parent_invalid');
 mkdirSync(directory,{mode:0o700});
 const path=join(directory,'ct.sqlite');if(resolve(identity.path)===path)throw Error('ct_metadata_identity_alias');
 const fd=openSync(path,'wx',0o600);closeSync(fd);
 const database=new Database({path});
 try{database.migrate();}catch(error){database.close();throw error;}
 const file=lstatSync(path),dir=lstatSync(directory);
 const state={identity,closed:false,device:file.dev,inode:file.ino,directoryInode:dir.ino};
 const store=Object.freeze({database,directory,close:()=>{if(state.closed)return;state.closed=true;database.close();}});
 stores.set(store,state);return store;
}
export function assertDedicatedCtStore(store:DedicatedCtStore,identity:Database):Database{
 const state=stores.get(store);if(!state||state.closed||state.identity!==identity||store.database===identity||store.database.path===identity.path)throw Error('ct_metadata_owner_required');
 const file=lstatSync(store.database.path),dir=lstatSync(store.directory);
 if(file.dev!==state.device||file.ino!==state.inode||dir.ino!==state.directoryInode||file.isSymbolicLink()||!file.isFile()||file.nlink!==1||file.uid!==process.getuid?.()||(file.mode&0o077)!==0||!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0)throw Error('ct_metadata_custody_changed');
 return store.database;
}
