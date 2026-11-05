import {mkdir,readFile,writeFile,copyFile,stat,lstat,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildWeb} from './build-web.mjs';
import {outsideGit} from './bundle-appearances.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function nativeSourceFiles(sourceRoot=root) {
 const list=options=>execFileSync('git',['ls-files','-z',...options,'--','ios','native'],{cwd:sourceRoot,encoding:'utf8'}).split('\0').filter(Boolean);
 // A local repair can introduce Swift files before it is committed. Include
 // those sources, but never sweep unrelated untracked assets into the app.
 const added=list(['--others','--exclude-standard']).filter(file=>/^(?:ios\/App\/App\/|ios\/App\/CapApp-SPM\/Sources\/|native\/(?:Sources|Tests)\/).+\.swift$/.test(file));
 const files=[...new Set([...list(['--cached']),...added])].filter(file=>!file.split('/').some(part=>['.swiftpm','.build','xcuserdata'].includes(part))).sort();
 const source=await realpath(sourceRoot);
 for(const file of files){
  const path=join(source,file),local=relative(source,await realpath(path));
  if(!(await lstat(path)).isFile()||local==='..'||local.startsWith('..'+sep))throw Error('Native project inputs must be regular files inside the source directory.');
 }
 return files;
}
export async function copyNativeSources(output,sourceRoot=root) {
 const files=await nativeSourceFiles(sourceRoot);
 for(const file of files){const target=join(output,file);await mkdir(dirname(target),{recursive:true});await copyFile(join(sourceRoot,file),target);}
 return files;
}
export async function packagePrivate({output,directory,ids,trustedRuntime,preserveFramingIds=[]}) {
 output=await outsideGit(output);await outsideGit(directory);
 try{await stat(output);throw Error('Choose a new output directory; existing builds are preserved.');}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir(output,{recursive:true});
 await copyNativeSources(output);
 // Copy only the explicit project inputs. Current local signing choices survive without entering Git.
 await copyFile(join(root,'capacitor.config.json'),join(output,'capacitor.config.json'));
 const config=JSON.parse(await readFile(join(root,'capacitor.config.json'),'utf8'));config.packageClassList=[];
 await writeFile(join(output,'ios/App/App/capacitor.config.json'),JSON.stringify(config,null,2)+'\n');
 await writeFile(join(output,'ios/App/App/config.xml'),'<?xml version="1.0" encoding="utf-8"?>\n<widget version="1.0.0" xmlns="http://www.w3.org/ns/widgets"></widget>\n');
 await buildWeb(join(output,'ios/App/App/public'),{directory,ids,trustedRuntime,preserveFramingIds});
 await writeFile(join(output,'BUILD-README.txt'),'Operator-local iOS project. Open ios/App/App.xcodeproj and Run with your signing team.\nAll selected presentation resources are bundled in App/public. Rebuild here with the source packager to change assets; do not run Capacitor sync in this generated project.\nPrivate assets in an app bundle can be extracted by anyone with access to the build. Authentication/audience controls protect display, not the bundled bytes at rest.\n');
 return {project:join(output,'ios/App/App.xcodeproj'),output};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [output,directory,...args]=process.argv.slice(2),ids=[],preserveFramingIds=[];for(let i=0;i<args.length;i++){if(args[i]==='--preserve-framing'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Provide a selected package ID after --preserve-framing.');preserveFramingIds.push(args[++i]);}else if(args[i].startsWith('--'))throw Error('Unknown packaging option.');else ids.push(args[i]);}if(!output||!directory||!ids.length)throw Error('Usage: node scripts/package-private.mjs <new-output-outside-git> <package-catalog-directory> <package-id> [...] [--preserve-framing <package-id>]');
 console.log(JSON.stringify(await packagePrivate({output:resolve(output),directory:resolve(directory),ids,preserveFramingIds}),null,2));
}
