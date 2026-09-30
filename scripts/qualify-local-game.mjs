import {open,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {replayGameLineage} from '../apps/server/src/runtime/game-lineage.ts';
import {createQualificationReport} from './qualification-report.mjs';

// Consume already collected, scoped local diagnostics. No capture, live-provider
// call, learning, controller, save, contact or lifecycle activation is available.
export async function evaluateLocalGameFile(inputPath,outputPath){
 if(typeof inputPath!=='string'||!inputPath)throw Error('A local diagnostic input is required.');
 // Nonblocking open lets the regular-file check reject FIFOs without waiting
 // for a writer. This qualifier never consumes an input stream.
 const file=await open(resolve(inputPath),constants.O_RDONLY|constants.O_NONBLOCK);let bytes;
 try{
  if(!(await file.stat()).isFile())throw Error('Diagnostic input must be a regular file.');
  const maximum=262144,buffer=Buffer.alloc(maximum+1);let used=0;
  while(used<buffer.length){const result=await file.read(buffer,used,buffer.length-used,null);if(!result.bytesRead)break;used+=result.bytesRead;}
  if(used>maximum)throw Error('Diagnostic input exceeds256KiB.');bytes=buffer.subarray(0,used);
 }finally{await file.close();}
 const result=await replayGameLineage(JSON.parse(bytes.toString('utf8'))),sha=value=>createHash('sha256').update(value).digest('hex');
 const sources=await Promise.all(['../apps/server/src/runtime/game-lineage.ts','../packages/runtime/src/replay/replay.ts','./qualify-local-game.mjs'].map(async path=>({path,sha256:sha(await readFile(new URL(path,import.meta.url)))})));
 const report={collectedAt:new Date().toISOString(),inputSha256:sha(bytes),evaluatorSources:sources,...result};
 const saved=await createQualificationReport(report,{outputPath,forbiddenRoot:fileURLToPath(new URL('../../',import.meta.url)),prefix:'lifestream-game-lineage-'});
 return {path:saved.path,status:report.correlation.status,metadataReplayEqual:report.comparison.equal,claimsRuntimeAcceptance:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--input','--output'].includes(key)||!args[i+1]||options[key])throw Error('Invalid arguments.');options[key]=args[i+1];}
  const result=await evaluateLocalGameFile(options['--input'],options['--output']);console.log(JSON.stringify(result));if(result.status==='contradictoryMetadata')process.exitCode=2;
 }catch{console.error('Game lineage evaluation failed. Check bounded local diagnostics and a new output path outside connected repositories. No runtime acceptance was recorded.');process.exitCode=1;}
}
