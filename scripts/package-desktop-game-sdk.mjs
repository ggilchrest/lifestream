import {cpSync,mkdirSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';

export function gameSdkInputs(root){
 const files=['packages/contracts/package.json','packages/providers-bizhawk/package.json','scripts/package-desktop-game-sdk.mjs'];
 const walk=directory=>{for(const name of readdirSync(join(root,directory))){const path=directory+'/'+name,stat=lstatSync(join(root,path));if(stat.isSymbolicLink())throw Error('SDK source symlink');if(stat.isDirectory())walk(path);else if(/\.(?:ts|json|lua)$/.test(name))files.push(path);}};
 for(const path of ['packages/contracts/src','packages/providers-bizhawk/src','packages/providers-bizhawk/native'])walk(path);
 return files.sort();
}
/** Public SDK only. Build from checked committed inputs, copy fixed vendor
 * dependencies and compiled packages, never a worktree, private state or assets. */
export function packageDesktopGameSdk(root,application){
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-b',join(root,'packages/providers-bizhawk')],{cwd:root,stdio:'inherit'});
 const target=join(application,'node_modules');mkdirSync(target);
 const copied=new Map(),require=createRequire(join(root,'packages/contracts/package.json'));
 function dependency(name,resolver){const manifest=resolver.resolve(name+'/package.json'),data=JSON.parse(readFileSync(manifest));if(copied.has(name)){if(copied.get(name)!==data.version)throw Error('SDK vendor version conflict');return;}copied.set(name,data.version);cpSync(dirname(manifest),join(target,name),{recursive:true,dereference:false});const local=createRequire(manifest);for(const child of Object.keys(data.dependencies??{}))dependency(child,local);}
 dependency('ajv',require);dependency('ajv-formats',require);
 for(const name of ['contracts','providers-bizhawk']){const directory=join(target,'@lifestream',name);mkdirSync(directory,{recursive:true});cpSync(join(root,'packages',name,'package.json'),join(directory,'package.json'));cpSync(join(root,'packages',name,'dist'),join(directory,'dist'),{recursive:true});}
 cpSync(join(root,'packages/contracts/src/schemas'),join(target,'@lifestream/contracts/dist/schemas'),{recursive:true});
 cpSync(join(root,'packages/providers-bizhawk/native'),join(application,'native'),{recursive:true});
 const files=[];
 function inventory(directory){for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('SDK package symlink');if(stat.isDirectory())inventory(path);else files.push({path:path.slice(application.length+1),bytes:stat.size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}}
 inventory(target);inventory(join(application,'native'));
 return {dependencies:Object.fromEntries(copied),files,scope:'Public compiled native SDK, schemas and reviewed Lua only; no ROM, save, owner state, credentials or activation setup.'};
}
