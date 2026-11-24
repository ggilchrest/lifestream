import {cp,readFile,writeFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
// The maintained Xcode project is Lifestream, not Capacitor's generated App template.
// Do not regenerate native code or overwrite a private, reviewed resource snapshot.
const root=new URL('../',import.meta.url), destination=new URL('ios/App/App/public',root);
try { if ((await lstat(destination)).isSymbolicLink()) throw Error('Private resources are linked. Use the reviewed private packaging workflow; generic sync would replace them.'); } catch(error) { if(error.code!=='ENOENT') throw error; }
await cp(new URL('dist/',root),destination,{recursive:true});
const config=JSON.parse(await readFile(new URL('capacitor.config.json',root),'utf8'));config.packageClassList=[];
await writeFile(new URL('ios/App/App/capacitor.config.json',root),JSON.stringify(config,null,2)+'\n');
console.log('Updated web resources for Lifestream.xcodeproj. Native source and signing were preserved.');
