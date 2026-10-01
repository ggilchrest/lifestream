// Portable Windows shell using a separately obtained, pinned official runtime.
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';

const root=resolve(import.meta.dirname,'..'),[output,runtimeInput]=process.argv.slice(2);
if(process.platform!=='win32'||process.arch!=='x64'||process.argv.length!==4||!output||!runtimeInput||!isAbsolute(output)||!isAbsolute(runtimeInput))throw Error('Usage on Windows x64: node scripts/package-desktop-windows.mjs C:\\new-output C:\\official-electron-runtime');
const destination=resolve(output),parent=realpathSync(dirname(destination)),runtime=realpathSync(runtimeInput);
if(parent===root||parent.startsWith(root+sep)||existsSync(destination))throw Error('Use a new output directory outside this checkout; existing output is never replaced.');
const expected=JSON.parse(readFileSync(join(root,'package.json'))).devDependencies.electron;
if(readFileSync(join(runtime,'version'),'utf8').trim()!==expected||!existsSync(join(runtime,'electron.exe')))throw Error('The runtime must match the exact project Electron pin. Obtain and verify the official vendor archive before packaging.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const revision=git('rev-parse','HEAD'),files=['apps/desktop/main.cjs','apps/desktop/preload.cjs','apps/desktop/connection-status.cjs','apps/desktop/package.json'];
const inputs=[...files,'scripts/package-desktop-windows.mjs','package.json','pnpm-lock.yaml','LICENSE','THIRD_PARTY_NOTICES.md'];
const sourceFiles=inputs.map(path=>{const bytes=readFileSync(join(root,path));if(!bytes.equals(execFileSync('git',['show',`HEAD:${path}`],{cwd:root})))throw Error('Commit the scoped packaging inputs before building: '+path);return {path,sha256:sha(bytes)};});
const runtimeFiles=[];
function inspect(directory){for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('Runtime symlinks are unsupported');if(stat.isDirectory())inspect(path);else if(stat.isFile())runtimeFiles.push({path:path.slice(runtime.length+1),bytes:stat.size,sha256:sha(readFileSync(path))});else throw Error('Unsupported runtime entry');}}
inspect(runtime);
if(existsSync(join(runtime,'resources','app')))throw Error('The vendor runtime contains unexpected application content.');
mkdirSync(destination);const app=join(destination,'Lifestream');cpSync(runtime,app,{recursive:true,dereference:false});renameSync(join(app,'electron.exe'),join(app,'Lifestream.exe'));
const application=join(app,'resources','app');mkdirSync(application);
for(const path of files)cpSync(join(root,path),join(application,path.split('/').at(-1)));
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])cpSync(join(root,name),join(application,name));
rmSync(join(app,'resources','default_app.asar'),{force:true});
const version=JSON.parse(readFileSync(join(application,'package.json'))).version;
writeFileSync(join(application,'build.json'),JSON.stringify({schemaVersion:'1.0.0',sourceRevision:revision,electronVersion:expected,architecture:'x64',version,sourceFiles},null,2)+'\n');
const receipt={schemaVersion:'1.0.0',status:'implementationCompleteVerificationPending',sourceRevision:revision,version,electronVersion:expected,architecture:'x64',platform:'win32',executable:'Lifestream/Lifestream.exe',executableSha256:sha(readFileSync(join(app,'Lifestream.exe'))),applicationFiles:readdirSync(application).sort(),sourceFiles,runtimeFiles,scope:'Generic loopback desktop shell only; no backend, credentials, private assets, state or provider configuration.',runtimeProvenance:'Operator must obtain and verify the official vendor archive separately; this receipt records exact copied runtime bytes.',securityChanges:false,signing:'Vendor executable bytes preserved; no new signing, trust or security-policy changes.',runtimeVerification:'pending'};
writeFileSync(join(destination,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({sourceRevision:revision,executable:join(app,'Lifestream.exe'),electronVersion:expected,executableSha256:receipt.executableSha256,status:receipt.status}));
