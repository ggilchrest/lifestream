import assert from 'node:assert/strict';
import test from 'node:test';
import {expectedGpuReady} from '../src/composition/gpu-readiness.ts';
import {ProviderRegistry} from '../src/composition/providers.ts';
import {loadConfig} from '../src/config/loader.ts';
import {sameHostInferenceEndpoint} from '../src/config/local-inference-endpoint.ts';

const required={pciBusId:'0000:01:00.0',serviceUnit:'inert-llama.service'};
const signal=()=>new AbortController().signal;
function runner(overrides:{devices?:string;processes?:string;changed?:boolean;fail?:boolean}={}){
 let pidCalls=0;
 return async(file:string,args:string[],s:AbortSignal)=>{
  assert(s instanceof AbortSignal);if(overrides.fail)throw Error('synthetic driver unavailable');
  if(file==='/usr/bin/systemctl'){
   assert.deepEqual(args,['--user','show',required.serviceUnit,'--property=MainPID','--value']);
   return overrides.changed&&++pidCalls>1?'124\n':'123\n';
  }
  assert.equal(file,'/usr/bin/nvidia-smi');
  assert.equal(args[1],'--format=csv,noheader,nounits');
  if(args[0]==='--query-gpu=pci.bus_id,uuid')return overrides.devices??'00000000:01:00.0, GPU-abcd-1234\n';
  assert.equal(args[0],'--query-compute-apps=gpu_uuid,pid');
  return overrides.processes??'GPU-abcd-1234, 123\n';
 };
}
test('expected device and stable provider service PID with GPU context are required',async()=>{
 assert.equal(await expectedGpuReady(required,signal(),runner()),true);
 for(const value of [{devices:''},{devices:'00000000:03:00.0, GPU-abcd-1234\n'},{processes:''},{processes:'GPU-abcd-1234, 999\n'},{processes:'GPU-other, 123\n'},{changed:true},{fail:true}])
  assert.equal(await expectedGpuReady(required,signal(),runner(value)),false,JSON.stringify(value));
});
test('cancelled device probe fails closed without retry',async()=>{
 const c=new AbortController();c.abort();let calls=0;
 const result=await expectedGpuReady(required,c.signal,async(_f,_a,s)=>{calls++;s.throwIfAborted();return '';});
 assert.equal(result,false);assert.equal(calls,1);
});
test('deadline during a device query fails closed without retry',async()=>{
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),20);let calls=0;
 try{
  assert.equal(await expectedGpuReady(required,c.signal,async(_f,_a,s)=>{
   calls++;return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(Error('synthetic deadline')),{once:true}));
  }),false);
  assert.equal(calls,1);
 }finally{clearTimeout(timer);}
});

const config=(gpu=true)=>loadConfig({defaults:{
 profile:'local-dev',providers:{inference:'llama-cpp-local',memory:'fixture',stt:'unavailable',tts:'fixture',world:'fixture',capability:'fixture',renderer:'fixture',clock:'system'},
 providerRequirements:{inference:'required',memory:'required',stt:'optional',tts:'optional',world:'optional',capability:'optional',renderer:'optional',clock:'required'},
 inferenceProfile:{runtime:'llama.cpp',runtimeVersion:'inert',model:'inert',modelRevision:'inert',servedModelName:'inert-model',quantization:'inert',contextLength:8192,endpoint:'http://127.0.0.1:19000',modelArtifactDigest:'sha256:inert',developmentOnly:true,...(gpu?{requiredGpu:required}:{})},
 storage:{databasePath:':memory:',artifactDirectory:'.artifacts'},authority:{provider:'fixture',authentication:'fixture'},secretRefs:{}
},profile:{},environment:{},cli:{}});

test('healthy CPU HTTP/tokenizer cannot mask required GPU loss; polling/busy does not churn health',async()=>{
 const previous=globalThis.fetch;let available=true,busy=false,tokenizers=0,probes=0;
 globalThis.fetch=async(input)=>{
  if(String(input).endsWith('/v1/models'))return Response.json({data:[{id:'inert-model'}],busy});
  assert(String(input).endsWith('/v1/chat/completions/input_tokens'));tokenizers++;
  return Response.json({object:'response.input_tokens',input_tokens:23});
 };
 try{
  const registry=new ProviderRegistry(config(),async()=>{probes++;return available;});
  await registry.probe();assert.equal(registry.ready,true);const stable=JSON.stringify(registry.providers);
  busy=true;await registry.probe();assert.equal(JSON.stringify(registry.providers),stable,'ordinary busy/polling must not alter authorization fingerprint');
  assert.equal(registry.providers.stt.status,'unavailable');assert.equal(registry.ready,true,'optional voice remains separate');
  available=false;const before=tokenizers;await registry.probe();assert.equal(registry.ready,false);assert.equal(tokenizers,before,'unavailable GPU blocks even CPU-only tokenization readiness');
  assert.equal(registry.providers.inference.reason,'configured inference GPU or service GPU execution is unavailable');
  await registry.probe();assert.equal(registry.ready,false);
  available=true;await registry.probe();assert.equal(registry.ready,true);assert.equal(JSON.stringify(registry.providers),stable);
  const cpu=new ProviderRegistry(config(false),async()=>{throw Error('unconfigured GPU must not be queried');});await cpu.probe();assert.equal(cpu.ready,true);assert.equal(probes,5);
 }finally{globalThis.fetch=previous;}
});

test('GPU requirement rejects remote/non-local provider and malformed device/service configuration',()=>{
 for(const mutate of [
  (c:any)=>{c.inferenceProfile.endpoint='http://remote.invalid';},
  (c:any)=>{c.providers.inference='ollama-mac-local';},
  (c:any)=>{c.inferenceProfile.requiredGpu.pciBusId='GPU-any';},
  (c:any)=>{c.inferenceProfile.requiredGpu.serviceUnit='--all';},
  (c:any)=>{c.inferenceProfile.requiredGpu.extra=true;}
 ]){const c=structuredClone(config());mutate(c);assert.throws(()=>loadConfig({defaults:c,profile:{},environment:{},cli:{}}),/GPU requirement|unknown inferenceProfile.requiredGpu/);}
});

test('same-host GPU endpoint permits the assigned LAN literal without trusting a subnet or DNS',()=>{
 const interfaces=['127.0.0.1','::1','192.168.2.15','2001:db8:0:0:0:0:0:15'];
 assert.equal(sameHostInferenceEndpoint(new URL('http://192.168.2.15:30000'),interfaces),true);
 assert.equal(sameHostInferenceEndpoint(new URL('http://[2001:db8::15]:30000'),interfaces),true);
 for(const url of ['http://192.168.2.16:30000','http://192.168.2.150:30000','http://10.0.0.2:30000','http://local-model.invalid:30000','http://0.0.0.0:30000','http://[::]:30000','https://192.168.2.15:30000','http://user:password@192.168.2.15:30000'])
  assert.equal(sameHostInferenceEndpoint(new URL(url),interfaces),false,url);
 assert.equal(sameHostInferenceEndpoint(new URL('http://192.168.2.15:30000'),['127.0.0.1']),false,'removed interface cannot attest a remote service');
 assert.equal(sameHostInferenceEndpoint(new URL('http://127.0.0.1:30000'),[]),true);
 assert.equal(sameHostInferenceEndpoint(new URL('http://localhost:30000'),[]),true);
});

test('loss of same-host binding stops GPU-required readiness before any HTTP request or GPU probe',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>{throw Error('remote endpoint must not be contacted');};let gpuCalls=0;
 try{
  const profile=config();profile.inferenceProfile!.endpoint='http://192.0.2.99:30000';
  const registry=new ProviderRegistry(profile,async()=>{gpuCalls++;return true;});await registry.probe();
  assert.equal(registry.ready,false);assert.equal(gpuCalls,0);assert.equal(registry.providers.inference.reason,'configured inference GPU endpoint is no longer on this host');
 }finally{globalThis.fetch=previous;}
});
