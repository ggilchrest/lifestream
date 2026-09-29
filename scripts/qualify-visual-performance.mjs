import {open,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {benchmarkVisualConversation} from '../packages/performance/src/benchmark.ts';
import {createQualificationReport} from './qualification-report.mjs';

// Scores already collected local measurements. Never opens a camera, contacts a
// provider, or produces synthetic results in place of missing measurements.
// node --experimental-strip-types scripts/qualify-visual-performance.mjs --input measurements.json --output /operator-local/new-report.json
export async function evaluateVisualPerformanceFile(inputPath,outputPath){
  if(typeof inputPath!=='string'||!inputPath)throw new Error('A local measurement input is required.');
  const file=await open(resolve(inputPath),'r');let bytes;
  try{
    if(!(await file.stat()).isFile())throw new Error('Measurement input must be a regular file.');
    const maximum=32*1024*1024,buffer=Buffer.alloc(maximum+1);let used=0;
    while(used<buffer.length){const result=await file.read(buffer,used,buffer.length-used,null);if(!result.bytesRead)break;used+=result.bytesRead;}
    if(used>maximum)throw new Error('Measurement input exceeds32MiB.');bytes=buffer.subarray(0,used);
  }finally{await file.close();}
  const input=JSON.parse(bytes.toString('utf8'));
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='environment,runs')throw new Error('Input must contain only environment and runs.');
  const result=benchmarkVisualConversation(input.environment,input.runs);
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const sources=await Promise.all(['../packages/performance/src/benchmark.ts','./qualify-visual-performance.mjs'].map(async path=>({path,sha256:sha(await readFile(new URL(path,import.meta.url)))})));
  const report={schemaVersion:'1.0.0',kind:'supplied-visual-performance-measurements',collectedAt:new Date().toISOString(),inputSha256:sha(bytes),evaluatorSources:sources,...result};
  const saved=await createQualificationReport(report,{outputPath,forbiddenRoot:fileURLToPath(new URL('../../',import.meta.url)),prefix:'lifestream-visual-performance-'});
  return {path:saved.path,status:report.status,qualification:report.qualification,claimsRuntimeAcceptance:false};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--input','--output'].includes(key)||!args[i+1]||options[key])throw new Error('Use --input <local measurements.json> [--output <new operator-local report.json>].');options[key]=args[i+1];}
    const result=await evaluateVisualPerformanceFile(options['--input'],options['--output']);
    console.log(JSON.stringify(result));if(result.status!=='passedMeasuredObjectives')process.exitCode=2;
  }catch{console.error('Visual performance evaluation failed. Check bounded measurement input, arguments and a new output path outside connected repositories. No runtime acceptance was recorded.');process.exitCode=1;}
}
