import {mkdir,writeFile,realpath,stat} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {PresentationPackages} from '../../server/src/admin/presentation-packages.ts';

// Private build products must never be generated inside a checkout, even an ignored directory.
export async function outsideGit(path) {
 let current=resolve(path),suffix=[];
 while(true){try{current=await realpath(current);break;}catch(error){if(error.code!=='ENOENT')throw error;suffix.unshift(current.slice(dirname(current).length+1));const parent=dirname(current);if(parent===current)throw error;current=parent;}}
 const result=resolve(current,...suffix);
 for(let dir=current;;dir=dirname(dir)){
  try{await stat(join(dir,'.git'));throw Error('Private appearance output must be outside every Git checkout.');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(dirname(dir)===dir)break;
 }
 return result;
}
export async function bundleAppearances(output,{directory,ids=[]}={}) {
 if(ids.length)await outsideGit(output);
 if(new Set(ids).size!==ids.length||ids.length>16)throw Error('Invalid appearance selection.');
 const source=ids.length?new PresentationPackages({directory,ownerPrincipalId:'build'}):null;
 const packages=ids.map(id=>{const item=source.list('build').find(item=>item.id===id);if(!item)throw Error('Selected appearance is invalid or unavailable.');if(item.manifest.resources.some(r=>r.bytes>64*1024*1024))throw Error('Mobile resource exceeds 64 MiB.');return item;});
 // Retain only declared, integrity-checked resources; never copy an entire private directory.
 for(const item of packages)for(const resource of item.manifest.resources){
  const dest=join(output,'appearances',item.id,resource.path),rel=relative(resolve(output),resolve(dest));
  if(rel.startsWith('..'+sep)||rel==='..')throw Error('Invalid resource path.');
  const {bytes}=source.resource('build',item.id,resource.path);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes);
 }
 const catalog={schemaVersion:'1.0.0',defaultId:packages[0]?.id??'neutral',neutral:{id:'neutral',label:'Neutral reference',digest:'neutral-v1'},packages};
 await mkdir(output,{recursive:true});await writeFile(join(output,'bundled-appearances.json'),JSON.stringify(catalog,null,2)+'\n');return catalog;
}
