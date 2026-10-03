// Local-only macOS bundle from the already installed, pinned Electron runtime.
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
const root=resolve(import.meta.dirname,'..'),output=process.argv[2];
if(process.platform!=='darwin'||!output||process.argv.length!==3||!isAbsolute(output))throw Error('Usage on macOS: node scripts/package-desktop.mjs /absolute/new/output-directory');
const destination=resolve(output),parent=realpathSync(dirname(destination));
if(parent===root||parent.startsWith(root+sep)||existsSync(destination))throw Error('Use a new output directory outside this checkout; existing output is never replaced.');
const files=['apps/desktop/main.cjs','apps/desktop/game-host-composition.cjs','apps/desktop/game-host-controls.cjs','apps/desktop/game-host-session-broker.cjs','apps/desktop/game-host-session-request.cjs','apps/desktop/game-host-diagnostics.cjs','apps/desktop/game-host-menu.cjs','apps/desktop/preload.cjs','apps/desktop/connection-status.cjs','apps/desktop/package.json'],inputs=[...files,'scripts/package-desktop.mjs','package.json','pnpm-lock.yaml','LICENSE','THIRD_PARTY_NOTICES.md'];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim(),revision=git('rev-parse','HEAD'),sha=b=>createHash('sha256').update(b).digest('hex');
const sourceFiles=inputs.map(path=>{const current=readFileSync(join(root,path)),committed=execFileSync('git',['show',`HEAD:${path}`],{cwd:root});if(!current.equals(committed))throw Error('Commit the scoped packaging inputs before building: '+path);return {path,sha256:sha(current)};});
const require=createRequire(import.meta.url),electronPackage=require.resolve('electron/package.json'),electron=JSON.parse(readFileSync(electronPackage)),expected=JSON.parse(readFileSync(join(root,'package.json'))).devDependencies.electron;
if(electron.version!==expected)throw Error('Installed Electron does not match the exact project pin.');
const source=join(dirname(electronPackage),'dist','Electron.app');if(!existsSync(source))throw Error('Install the pinned macOS Electron runtime before packaging. No download was attempted.');
mkdirSync(destination,{mode:0o700});const app=join(destination,'Lifestream.app');cpSync(source,app,{recursive:true,dereference:false,verbatimSymlinks:true});renameSync(join(app,'Contents','MacOS','Electron'),join(app,'Contents','MacOS','Lifestream'));
const resources=join(app,'Contents','Resources'),application=join(resources,'app');if(existsSync(application))throw Error('Unexpected application content in the installed runtime.');mkdirSync(application);
for(const path of files)cpSync(join(root,path),join(application,path.split('/').at(-1)));
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])cpSync(join(root,name),join(application,name));
const thirdPartyNotices=['LICENSE','LICENSES.chromium.html'].map(name=>{
 const bytes=readFileSync(join(dirname(electronPackage),'dist',name)),target=name==='LICENSE'?'LICENSE.electron.txt':name;
 writeFileSync(join(resources,target),bytes);return {path:'Contents/Resources/'+target,sha256:sha(bytes),bytes:bytes.length};
});
rmSync(join(resources,'default_app.asar'),{force:true});
const version=JSON.parse(readFileSync(join(application,'package.json'))).version;
writeFileSync(join(application,'build.json'),JSON.stringify({schemaVersion:'1.0.0',sourceRevision:revision,electronVersion:electron.version,architecture:process.arch,version,sourceFiles},null,2)+'\n');
const plist=join(app,'Contents','Info.plist');for(const [key,value]of Object.entries({CFBundleIdentifier:'dev.lifestream.local-endpoint',CFBundleExecutable:'Lifestream',CFBundleName:'Lifestream',CFBundleDisplayName:'Lifestream',CFBundleShortVersionString:version,CFBundleVersion:version,NSMicrophoneUsageDescription:'Lifestream uses your microphone only when you start a voice interaction.'})){
 try{execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist],{stdio:'pipe'});}catch{execFileSync('/usr/libexec/PlistBuddy',['-c',`Add :${key} string ${value}`,plist],{stdio:'pipe'});}
}
// Ad-hoc local integrity signing uses no identity, account, timestamp or network.
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-','--timestamp=none',app],{stdio:'pipe'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});
let fileCount=0,bytes=0;const symlinks=[];
function inspect(directory){for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink()){const target=realpathSync(path);if(!target.startsWith(app+sep))throw Error('Bundle contains an external symlink: '+relative(app,path));symlinks.push({path:relative(app,path),target:readlinkSync(path)});}else if(stat.isDirectory())inspect(path);else if(stat.isFile()){fileCount++;bytes+=stat.size;}else throw Error('Unsupported bundle entry');}}
inspect(app);const archive=join(destination,'Lifestream-mac-'+process.arch+'.zip');execFileSync('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--noacl','--keepParent',app,archive],{stdio:'pipe'});
const archiveMembers=execFileSync('/usr/bin/unzip',['-Z','-1',archive],{encoding:'utf8'}).trim().split('\n'),applicationFiles=readdirSync(application).sort(),prefix='Lifestream.app/Contents/Resources/app/';
if(archiveMembers.some(name=>name.startsWith('/')||name.split('/').some(part=>part==='..'||part==='__MACOSX'||part.startsWith('._'))))throw Error('Unexpected path or local filesystem metadata in the final ZIP.');
const packagedFiles=archiveMembers.filter(name=>name.startsWith(prefix)&&!name.endsWith('/')).map(name=>name.slice(prefix.length)).sort();
if(JSON.stringify(packagedFiles)!==JSON.stringify(applicationFiles))throw Error('Final ZIP differs from the explicit application allowlist.');
for(const notice of thirdPartyNotices)if(!archiveMembers.includes('Lifestream.app/'+notice.path))throw Error('Final ZIP is missing a runtime notice.');
const archiveBytes=readFileSync(archive),receipt={schemaVersion:'1.0.0',status:'implementationCompleteVerificationPending',createdAt:new Date().toISOString(),sourceRevision:revision,version,electronVersion:electron.version,architecture:process.arch,app:'Lifestream.app',archive:archive.split('/').at(-1),archiveSha256:sha(archiveBytes),archiveBytes:archiveBytes.length,archiveMembers:archiveMembers.length,localFilesystemMetadataOmitted:true,files:fileCount,uncompressedBytes:bytes,symlinks,applicationFiles,sourceFiles,thirdPartyNotices,signing:'ad-hoc local; no Developer ID, notarization or distribution claim',scope:'Generic endpoint shell only. No backend, private packages, credentials, state, Lab, model or provider configuration. Runtime connects to the explicit loopback endpoint.',runtimeVerification:'pending'};
writeFileSync(join(destination,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({sourceRevision:revision,app,archive,archiveBytes:receipt.archiveBytes,archiveSha256:receipt.archiveSha256,status:receipt.status}));
