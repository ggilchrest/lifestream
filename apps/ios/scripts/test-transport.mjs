import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function nativeTransportProbe(configuration){
 const build=await mkdtemp(join(tmpdir(),'ls-ios-native-'));
 try{
  await copyFile(resolve(root,"test/"+(configuration.probe ?? "transport-probe.swift")),join(build,"main.swift"));
  for(const args of [
   ['-emit-library','-emit-module','-module-name','AssistantCore',resolve(root,'native/Sources/AssistantCore/VoiceProtocol.swift'),'-o',join(build,'libAssistantCore.dylib'),'-emit-module-path',join(build,'AssistantCore.swiftmodule')],
   ['-D','DEBUG','-I',build,'-L',build,'-lAssistantCore','-Xlinker','-rpath','-Xlinker',build,resolve(root,'ios/App/CapApp-SPM/Sources/CapApp-SPM/NativeTransport.swift'),resolve(root,'ios/App/CapApp-SPM/Sources/CapApp-SPM/ConnectionStore.swift'),join(build,'main.swift'),'-o',join(build,'probe')]
  ]){const result=spawnSync('swiftc',args,{encoding:'utf8'});if(result.status)throw Error(result.stderr);}
  return await new Promise((resolve,reject)=>{
   const child=spawn(join(build,'probe'),[],{stdio:['pipe','pipe','pipe']});let out='',error='';
   child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);
   child.on('close',(code,signal)=>{if(code!==0)return reject(Error(error||`Native probe exited ${code} ${signal}`));try{resolve(JSON.parse(out))}catch{reject(Error('Native probe returned no result. '+error))}});
   child.stdin.end(JSON.stringify(configuration)+'\n');
  });
 }finally{await rm(build,{recursive:true,force:true});}
}
