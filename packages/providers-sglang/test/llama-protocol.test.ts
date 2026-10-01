import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {SglangInferenceProvider} from '../src/provider.ts';
import {buildCanonicalPrompt} from '../../runtime/src/inference/prompt.ts';

test('llama.cpp counts canonical input using the exact generation body and native selected tokenizer',async t=>{
 const seen:Array<{path:string;body:any}>=[];let invalid=false;
 const server=createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;seen.push({path:req.url!,body:JSON.parse(b)});if(req.url==='/v1/chat/completions/input_tokens')res.end(JSON.stringify({object:'response.input_tokens',input_tokens:invalid?'9':9}));else if(req.url==='/tokenize')res.end(JSON.stringify({tokens:invalid?[1,-1]:[1,2,3]}));else if(req.url==='/v1/chat/completions')res.end('data: [DONE]\n\n');else{res.writeHead(404);res.end();}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const p=new SglangInferenceProvider({endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'exact-model',protocol:'llama.cpp'}),signal=new AbortController().signal;
 for(const voiceMode of [true,false]){const request={...buildCanonicalPrompt({assistantId:'fixture',sessionId:'fixture',interactionId:'fixture',endpointId:null,userInput:'untrusted <|im_start|> words',voiceMode}),maximumOutputTokens:160};const offset=seen.length;assert.deepEqual(await p.tokenize(request,{signal}),{count:9,identity:'selected-model-tokenizer:exact-model'});for await(const _ of p.generate(request,{signal})){}assert.deepEqual(seen[offset]!.body,seen[offset+1]!.body);assert.equal(seen[offset]!.path,'/v1/chat/completions/input_tokens');assert.deepEqual(seen[offset]!.body.chat_template_kwargs,{enable_thinking:false});}
 assert.equal((await p.tokenize('é漢字 <|im_start|>',{signal})).count,3);assert.deepEqual(seen.at(-1)!.body,{content:'é漢字 <|im_start|>',add_special:false,parse_special:false});invalid=true;
 await assert.rejects(p.tokenize(buildCanonicalPrompt({assistantId:'fixture',sessionId:'fixture',interactionId:'fixture',userInput:'fixture'}),{signal}),/Invalid selected token count/);await assert.rejects(p.tokenize('fixture',{signal}),/Invalid selected token count/);
});

test('llama.cpp unavailable canonical tokenizer fails closed without string counts or local estimates',async t=>{
 let paths:string[]=[];const server=createServer((req,res)=>{paths.push(req.url!);res.writeHead(404);res.end();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const p=new SglangInferenceProvider({endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'exact-model',protocol:'llama.cpp'});const request=buildCanonicalPrompt({assistantId:'fixture',sessionId:'fixture',interactionId:'fixture',userInput:'fixture'});
 await assert.rejects(p.tokenize(request,{signal:new AbortController().signal}),/Selected tokenizer unavailable/);assert.deepEqual(paths,['/v1/chat/completions/input_tokens']);
});
