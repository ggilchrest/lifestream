import {mkdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildWeb} from './build-web.mjs';
import {outsideGit} from './bundle-appearances.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function packagePrivate({output,directory,ids}) {
 output=await outsideGit(output);await outsideGit(directory);
 try{await stat(output);throw Error('Choose a new output directory; existing builds are preserved.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const files=execFileSync('git',['ls-files','-z','ios','native'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 await mkdir(output,{recursive:true});
 for(const file of files){if(file.includes('/.swiftpm/')||file.includes('/xcuserdata/'))continue;const target=join(output,file);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,file),target);}
 // Copy only the explicit project inputs. Current local signing choices survive without entering Git.
 await copyFile(join(root,'capacitor.config.json'),join(output,'capacitor.config.json'));
 const config=JSON.parse(await readFile(join(root,'capacitor.config.json'),'utf8'));config.packageClassList=[];
 await writeFile(join(output,'ios/App/App/capacitor.config.json'),JSON.stringify(config,null,2)+'\n');
 await writeFile(join(output,'ios/App/App/config.xml'),'<?xml version="1.0" encoding="utf-8"?>\n<widget version="1.0.0" xmlns="http://www.w3.org/ns/widgets"></widget>\n');
 await buildWeb(join(output,'ios/App/App/public'),{directory,ids});
 await writeFile(join(output,'BUILD-README.txt'),'Operator-local iOS project. Open ios/App/App.xcodeproj and Run with your signing team.\nAll selected presentation resources are bundled in App/public. Rebuild here with the source packager to change assets; do not run Capacitor sync in this generated project.\nPrivate assets in an app bundle can be extracted by anyone with access to the build. Authentication/audience controls protect display, not the bundled bytes at rest.\n');
 return {project:join(output,'ios/App/App.xcodeproj'),output};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [output,directory,...ids]=process.argv.slice(2);if(!output||!directory||!ids.length)throw Error('Usage: node scripts/package-private.mjs <new-output-outside-git> <package-catalog-directory> <package-id> [...]');
 console.log(JSON.stringify(await packagePrivate({output:resolve(output),directory:resolve(directory),ids}),null,2));
}
