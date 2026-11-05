import type { InferenceChunk,CtPrivateResponseCapture, InferenceProvider, InferenceRequest, ProviderCallContext } from "@lifestream/runtime/inference";
import { createHash } from "node:crypto";
import {types} from 'node:util';

/** Optional metadata cannot add a prerequisite to the existing provider API. */
type ProviderTraceShape={responseFormatKind?:'absent'|'object'|'nullable-object';responseFormatSha256?:string;maximumOutputTokens?:number;dataFrames?:number;contentBytes?:number;reasoningBytes?:number;messageContentBytes?:number;toolCallFrames?:number;refusalBytes?:number};
function providerTextTrace(request:unknown,enabled:boolean):(phase:string,completionId?:string,shape?:ProviderTraceShape)=>void{
  if(!enabled)return ()=>{};
  try{
    if(!request||typeof request!=='object'||types.isProxy(request))return ()=>{};
    const requestPrototype=Object.getPrototypeOf(request);if(requestPrototype!==Object.prototype&&requestPrototype!==null)return ()=>{};
    const scope=Object.getOwnPropertyDescriptor(request,'scope');
    if(!scope||!Object.hasOwn(scope,'value')||!scope.value||typeof scope.value!=='object'||types.isProxy(scope.value))return ()=>{};
    const prototype=Object.getPrototypeOf(scope.value);if(prototype!==Object.prototype&&prototype!==null)return ()=>{};
    const identity=Object.getOwnPropertyDescriptor(scope.value,'interactionId');
    if(!identity||!Object.hasOwn(identity,'value')||typeof identity.value!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i).test(identity.value))return ()=>{};
    const interactionId=identity.value,started=performance.now();
    return (phase,completionId,shape)=>{try{console.info(JSON.stringify({event:'typed-provider-timing',interactionId,phase,observedAtMs:Date.now(),elapsedMs:Math.max(0,Math.round(performance.now()-started)),...(completionId?{completionId}:{}),...(shape??{})}));}catch{}};
  }catch{return ()=>{};}
}

const canonicalKinds = ["policy", "corePersona", "adaptivePersona", "interactionState", "preparedMemory", "worldContext", "capabilityState", "conversation", "userInput"];
// A host-authored structured-output request constrains decoding; the caller
// still validates every returned value and its current source references.
const validResponseFormat = (format: InferenceRequest["responseFormat"]): boolean => {
  if (format === undefined) return true;
  if (!format || typeof format !== 'object' || Array.isArray(format)) return false;
  try {
    const body = format.json_schema;
    return Object.keys(format).sort().join(',') === 'json_schema,type' && format.type === 'json_schema'
      && !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === 'name,schema'
      && typeof body.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(body.name)
      && !!body.schema && typeof body.schema === 'object' && !Array.isArray(body.schema)
      && (body.schema.type === 'object' || (Array.isArray(body.schema.anyOf) && body.schema.anyOf.length===2 && body.schema.anyOf.every((branch:unknown)=>!!branch&&typeof branch==='object'&&!Array.isArray(branch)) && body.schema.anyOf[0].type==='object' && body.schema.anyOf[1].type==='null')) && Buffer.byteLength(JSON.stringify(format)) <= 32768;
  } catch { return false; }
};
const validCanonicalRequest = (request: InferenceRequest): boolean => {
  if (!validResponseFormat(request.responseFormat)) return false;
  if(request.maximumOutputTokens!==undefined&&(!Number.isInteger(request.maximumOutputTokens)||request.maximumOutputTokens<1||request.maximumOutputTokens>4096))return false;
  if (!Array.isArray(request.sections) || request.sections.length !== canonicalKinds.length || request.manifest?.schemaVersion !== "1.0.0" || !request.manifest.tokenizer || request.manifest.sections?.length !== canonicalKinds.length || !Number.isFinite(Date.parse(request.deadlineAt))) return false;
  return request.sections.every((section, index) => {
    if (!section || section.kind !== canonicalKinds[index] || typeof section.content !== "string" || typeof section.sourceRef !== "string" || !section.sourceRef || typeof section.sourceRevision !== "string" || !section.sourceRevision || !["none", "redacted"].includes(section.redaction) || !Number.isInteger(section.tokenCount) || section.tokenCount < 0) return false;
    const trusted = index < 4;
    if (section.trusted !== trusted || section.contentDigest !== createHash("sha256").update(section.content, "utf8").digest("hex")) return false;
    const manifest = request.manifest.sections[index];
    return Boolean(manifest) && ["kind", "sourceRevision", "sourceRef", "contentDigest", "redaction", "tokenCount"].every((key) => manifest![key as keyof typeof manifest] === section[key as keyof typeof section]);
  });
};

const messagesFor=(request:InferenceRequest)=>[{role:'system',content:request.sections.slice(0,4).map(s=>`[${s.kind}; trusted]\n${s.content}`).join('\n\n')},{role:'user',content:request.sections.slice(4).map(s=>`[${s.kind}; untrusted]\n${s.content}`).join('\n\n')}];
const directRequest=(request:InferenceRequest)=>request.sections.some(s=>s.kind==='policy'&&s.trusted&&['policy:v1','policy:spoken-v1'].includes(s.sourceRef));
// Recognize the pinned legacy proposal and explicit v1 intent wire contracts.
// Only advice-set and bounded ordinary wall-safety narrowing may vary; neither grants execution authority.
// This recognition selects transport batching/capture, never execution authority.
const gameProposalFormat=(format:InferenceRequest['responseFormat']):boolean=>{
 try{
  if(!format)return false;const serialized=JSON.stringify(format),pins=['4032e9b40c3376cf7b35e633a64a14701260ab3c36cb61eeb4e4c72347cbed3a','82b56b8ea4da311f0f63728404dc6d51d0070f028170a8703c8313572ffb150d'],hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  if(pins.includes(hash(serialized)))return true;if(Buffer.byteLength(serialized)>32768)return false;
  const copy=JSON.parse(serialized),advice=copy.json_schema.schema.anyOf[0].properties.adviceRefs,refs=advice.items.enum;
  if(!Number.isSafeInteger(advice.maxItems)||advice.maxItems<0||advice.maxItems>8)return false;
  if(advice.maxItems===0){if(refs!==undefined)return false;}else if(!Array.isArray(refs)||refs.length<advice.maxItems||new Set(refs).size!==refs.length||refs.some((ref:unknown)=>typeof ref!=='string'||ref.length<1||ref.length>1000))return false;
  const wall=copy.json_schema.schema.anyOf[0].properties.maxWallMs;
  if(Object.hasOwn(wall,'const')){if(copy.json_schema.name!=='game_action_intent_v1'||!Number.isSafeInteger(wall.const)||wall.const<1||wall.const>2000)return false;delete wall.const;}
  delete advice.items.enum;advice.maxItems=8;return pins.includes(hash(JSON.stringify(copy)));
 }catch{return false;}
};
// Exact host-authored proposal syntax and activity origin, not provider text.
// Ordinary Daily and other structured requests retain their original deltas.
const batchGameText=(request:InferenceRequest)=>request.sections.some(s=>s.kind==='interactionState'&&s.sourceRef==='runtime-self-context:v1'&&s.trusted&&s.content.startsWith(`assistant=${request.scope.assistantId};session=${request.scope.sessionId};interaction=${request.scope.interactionId};endpoint=${request.scope.endpointId??'none'};origin=activityStep;`))&&gameProposalFormat(request.responseFormat);

export type SglangConfig = { endpoint: string; model: string; protocol?: "sglang" | "llama.cpp"; apiKey?: string; maxResponseBytes?: number };

export class SglangInferenceProvider implements InferenceProvider {
  readonly ctPrivateRequestCaptureSupported=true as const;
  private readonly config: SglangConfig;
  // Transport cleanup remains owned after caller cancellation. Native GPU slot
  // release is independently qualified; this set is not a native release proof.
  private transportReservations = 0;
  private tokenizationReservations = 0;
  get transportQuiescent():boolean{return this.transportReservations===0&&this.tokenizationReservations===0&&this.transportCleanups.size===0;}
  private readonly transportCleanups = new Set<Promise<void>>();
  get pendingTransportCleanupCount(): number { return this.transportCleanups.size; }
  async drainTransportCleanups(): Promise<void> {
    await Promise.all([...this.transportCleanups]);
  }
  private deferTransportCleanup(cleanup: () => Promise<void>): void {
    const pending = new Promise<void>((resolve) => {
      setImmediate(() => { cleanup().then(resolve, resolve); });
    });
    this.transportCleanups.add(pending);
    pending.then(() => { this.transportCleanups.delete(pending); });
  }
  constructor(config: SglangConfig) { this.config = config; }
  async tokenize(input:InferenceRequest|string,context:ProviderCallContext):Promise<{count:number;identity:string}>{
    if(typeof input!=='string'&&(!validCanonicalRequest(input)||input.executionMode==='replay'))throw Error('Invalid tokenization request.');
    this.tokenizationReservations++;try{
    const llama=this.config.protocol==='llama.cpp';
    const path=llama?(typeof input==='string'?'/tokenize':'/v1/chat/completions/input_tokens'):'/v1/tokenize';
    const body=llama?(typeof input==='string'?{content:input,add_special:false,parse_special:false}:this.chatBody(input)):typeof input==='string'?{model:this.config.model,prompt:input,add_special_tokens:false}:{model:this.config.model,messages:messagesFor(input),...(directRequest(input)?{chat_template_kwargs:{enable_thinking:false}}:{})};
    if(Buffer.byteLength(JSON.stringify(body))>131072)throw Error('Tokenization input bound exceeded.');
    const signal=AbortSignal.any([context.signal,AbortSignal.timeout(10000)]),response=await fetch(this.config.endpoint.replace(/\/$/u,'')+path,{method:'POST',headers:{'content-type':'application/json',...(this.config.apiKey?{authorization:`Bearer ${this.config.apiKey}`}:{})},body:JSON.stringify(body),signal});
    if(!response.ok||!response.body)throw Error('Selected tokenizer unavailable.');const chunks:Uint8Array[]=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw Error('Tokenizer response bound exceeded.');chunks.push(chunk);}const parsed=JSON.parse(Buffer.concat(chunks).toString());
    if(llama){
      const count=typeof input==='string'?(Array.isArray(parsed.tokens)&&parsed.tokens.every((x:unknown)=>Number.isInteger(x)&&Number(x)>=0)?parsed.tokens.length:undefined):parsed.input_tokens;
      if(!Number.isSafeInteger(count)||count<0||count>131072||(typeof input!=='string'&&parsed.object!=='response.input_tokens'))throw Error('Invalid selected token count.');
      return {count,identity:'selected-model-tokenizer:'+this.config.model};
    }
    if(!Number.isInteger(parsed.count)||parsed.count<0||!Array.isArray(parsed.tokens)||parsed.count!==parsed.tokens.length||!parsed.tokens.every((x:unknown)=>Number.isInteger(x)))throw Error('Invalid selected token count.');
    return {count:parsed.count,identity:'selected-model-tokenizer:'+this.config.model};
    }finally{this.tokenizationReservations--;}
  }
  private chatBody(request:InferenceRequest){return {model:this.config.model,stream:true,...(request.responseFormat===undefined?{}:{response_format:request.responseFormat}),...(request.maximumOutputTokens===undefined?{}:{max_tokens:request.maximumOutputTokens}),...(directRequest(request)?{chat_template_kwargs:{enable_thinking:false}}:{}),messages:messagesFor(request)};}
  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> {
    if (request.executionMode === "replay") { yield { kind: "error", error: { code: "replay_live_provider_forbidden", message: "live inference is unavailable during replay" } }; return; }
    if (!validCanonicalRequest(request)) { yield { kind: "error", error: { code: "invalid_canonical_request", message: "inference requires the ordered canonical sections and matching trusted-source manifest" } }; return; }
    const remainingMs = Date.parse(request.deadlineAt) - Date.now();
    if (remainingMs <= 0) { yield { kind: "error", error: { code: "deadline_exceeded", message: "inference deadline exceeded" } }; return; }
    if (this.transportReservations >= 64) {
      yield { kind: "error", error: { code: "inference_unavailable", message: "inference transport cleanup capacity unavailable" } }; return;
    }
    this.transportReservations++;
    const traceEnabled=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1',trace=providerTextTrace(request,traceEnabled);
    let completionRecorded=false;const streamShape={dataFrames:0,contentBytes:0,reasoningBytes:0,messageContentBytes:0,toolCallFrames:0,refusalBytes:0};const addCount=(key:keyof typeof streamShape,value:number)=>{streamShape[key]=Math.min(2147483647,streamShape[key]+value);};trace('transport-reserved');
    const controller = new AbortController(); const abort = () => {controller.abort(context.signal.reason);trace('abort-forwarded');}; context.signal.addEventListener("abort", abort, { once: true });
    if(context.signal.aborted)controller.abort(context.signal.reason);
    let deadlineExceeded = false;
    const activeTurn=context.activeTurn;
    if(activeTurn&&(!Number.isSafeInteger(activeTurn.noProgressMs)||activeTurn.noProgressMs<1||activeTurn.noProgressMs>120000)){this.transportReservations--;context.signal.removeEventListener("abort",abort);yield {kind:'error',error:{code:'invalid_active_turn',message:'Invalid active turn stall bound'}};return;}
    let deadlineTimer = setTimeout(() => { deadlineExceeded = true; controller.abort(); },activeTurn?.noProgressMs??Math.min(remainingMs, 2_147_483_647));
    const progress=()=>{if(!activeTurn||controller.signal.aborted)return;clearTimeout(deadlineTimer);deadlineTimer=setTimeout(()=>{deadlineExceeded=true;controller.abort();},activeTurn.noProgressMs);};
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseCapture:CtPrivateResponseCapture|undefined,responseCaptureClosed=false,httpStatus:number|null=null,transportEof=false;
    let parserTerminal:Parameters<CtPrivateResponseCapture['finish']>[0]['parserTerminal']='consumer_closed';
    const finishCapture=()=>{if(responseCapture&&!responseCaptureClosed){responseCaptureClosed=true;responseCapture.finish({httpStatus,transportEof,parserTerminal});}};
    // Enabled diagnostic only: bounded by the original deadline/abort and sink
    // byte cap. Runs only in post-DONE owned cleanup; no grant is renewed.
    const drainCapture=async()=>{if(responseCapture&&reader)for(;;){
      controller.signal.throwIfAborted();let abortRead:(()=>void)|undefined;
      try{const item=await Promise.race([reader.read(),new Promise<never>((_resolve,reject)=>{abortRead=()=>reject(Error('CT private response drain cancelled'));controller.signal.addEventListener('abort',abortRead,{once:true});if(controller.signal.aborted)abortRead();})]);controller.signal.throwIfAborted();if(item.done){transportEof=true;break;}responseCapture.append(item.value);}
      finally{if(abortRead)controller.signal.removeEventListener('abort',abortRead);}
    }};
    try {
      // Runtime-owned typed and spoken prompts select the supported direct-answer mode.
      // This is a per-request mapping; untrusted text cannot change decoding or deadlines.
      const body=this.chatBody(request),serializedBody=JSON.stringify(body);
      if(context.ctPrivateRequestCapture!==undefined){
        if(typeof context.ctPrivateRequestCapture!=='function'||!batchGameText(request)||request.sections[8]?.content!==''||Object.keys(context).some(key=>!['signal','ctPrivateRequestCapture'].includes(key)))throw Error('CT private capture unavailable');
        let abortCapture:(()=>void)|undefined;
        try{
          controller.signal.throwIfAborted();
          const cancelled=new Promise<never>((_resolve,reject)=>{abortCapture=()=>reject(controller.signal.reason??Error('CT private capture cancelled'));controller.signal.addEventListener('abort',abortCapture,{once:true});if(controller.signal.aborted)abortCapture();});
          responseCapture=await Promise.race([context.ctPrivateRequestCapture(request,serializedBody),cancelled])||undefined;controller.signal.throwIfAborted();
        }finally{if(abortCapture)controller.signal.removeEventListener('abort',abortCapture);}
      }
      if(traceEnabled)trace('request-shape',undefined,{responseFormatKind:body.response_format===undefined?'absent':body.response_format.json_schema.schema.type==='object'?'object':'nullable-object',...(body.response_format===undefined?{}:{responseFormatSha256:createHash('sha256').update(JSON.stringify(body.response_format)).digest('hex')}),...(body.max_tokens===undefined?{}:{maximumOutputTokens:body.max_tokens})});
      const response = await fetch(`${this.config.endpoint.replace(/\/$/u, "")}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: serializedBody, signal: controller.signal });
      httpStatus=response.status;reader = response.body?.getReader();
      controller.signal.throwIfAborted();
      if (!response.ok || !response.body || !reader) { parserTerminal='http_error';yield { kind: "error", error: { code: "inference_unavailable", message: `inference service returned HTTP ${response.status}` } }; return; }
      const decoder = new TextDecoder(); let buffer = ""; let emitted = 0; const max = this.config.maxResponseBytes ?? 64_000;
      const batchText=batchGameText(request);
      for (;;) {
        const next = await reader.read(); controller.signal.throwIfAborted(); if (next.done){transportEof=true;break;}responseCapture?.append(next.value);
        // Never wait for another network read to fill a batch. These bytes are
        // already buffered; each delivered batch gets the caller's full fresh
        // check, while its logical fragments keep the original chunk budget.
        let pendingText='',sourceChunkCount=0;
        buffer += decoder.decode(next.value, { stream: true });
        const lines=buffer.split('\n');buffer=lines.pop()??'';
        if(Buffer.byteLength(buffer)>max){parserTerminal='response_limit';yield {kind:'error',error:{code:'response_limit',message:'inference stream frame limit exceeded'}};return;}
        for (const line of lines) {
          controller.signal.throwIfAborted();
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { if(sourceChunkCount){yield {kind:'text',text:pendingText,sourceChunkCount};controller.signal.throwIfAborted();}parserTerminal='done';trace('provider-terminal-done');yield { kind: "done" }; return; }
          try {
            const parsed=JSON.parse(data),choice=parsed?.choices?.[0];
            if(traceEnabled){addCount('dataFrames',1);for(const [key,value]of [['contentBytes',choice?.delta?.content],['reasoningBytes',choice?.delta?.reasoning_content],['messageContentBytes',choice?.message?.content],['refusalBytes',choice?.delta?.refusal]]as const)if(typeof value==='string')addCount(key,Buffer.byteLength(value));if(choice?.delta?.tool_calls!=null||choice?.delta?.function_call!=null)addCount('toolCallFrames',1);}
            if(traceEnabled&&!completionRecorded&&typeof parsed?.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(parsed.id)){completionRecorded=true;trace('first-provider-frame',parsed.id);}
            if(choice?.finish_reason!==undefined&&choice.finish_reason!==null)trace(choice.finish_reason==='length'?'provider-finish-length':choice.finish_reason==='stop'?'provider-finish-stop':'provider-finish-other');
            if(choice?.finish_reason==='length'){parserTerminal='length';if(sourceChunkCount){yield {kind:'text',text:pendingText,sourceChunkCount};controller.signal.throwIfAborted();pendingText='';sourceChunkCount=0;}yield {kind:'error',error:{code:'response_limit',message:'inference provider reached its generation limit'}};return;}
            const text = choice?.delta?.content;
            if (typeof text === "string" && text.length) {
              progress();const bytes=Buffer.byteLength(text);emitted+=bytes;if(emitted>max){parserTerminal='response_limit';if(sourceChunkCount){yield {kind:'text',text:pendingText,sourceChunkCount};controller.signal.throwIfAborted();pendingText='';sourceChunkCount=0;}yield {kind:'error',error:{code:'response_limit',message:'inference response limit exceeded'}};return;}
              if(!batchText){yield {kind:'text',text};continue;}
              // The coordinator's existing maximum output bound is32768.
              if(bytes>32768){parserTerminal='response_limit';if(sourceChunkCount){yield {kind:'text',text:pendingText,sourceChunkCount};controller.signal.throwIfAborted();pendingText='';sourceChunkCount=0;}yield {kind:'error',error:{code:'response_limit',message:'inference response limit exceeded'}};return;}
              if(sourceChunkCount&&(sourceChunkCount===4096||Buffer.byteLength(pendingText)+bytes>32768)){yield {kind:'text',text:pendingText,sourceChunkCount};controller.signal.throwIfAborted();pendingText='';sourceChunkCount=0;}
              pendingText+=text;sourceChunkCount++;
            }
          } catch(error) { parserTerminal='malformed';if(controller.signal.aborted)throw error;if(sourceChunkCount){yield {kind:'text',text:pendingText,sourceChunkCount};controller.signal.throwIfAborted();pendingText='';sourceChunkCount=0;}yield {kind:'error',error:{code:'malformed_provider_event',message:'inference provider returned malformed stream data'}};return; }
        }
        if(sourceChunkCount){controller.signal.throwIfAborted();yield {kind:'text',text:pendingText,sourceChunkCount};}
      }
      controller.signal.throwIfAborted();parserTerminal='malformed';
      yield { kind: "error", error:{code:'malformed_provider_event',message:'inference stream ended without a terminal event'} };
    } catch (error) { parserTerminal=deadlineExceeded?'deadline':context.signal.aborted?'cancelled':'other';if (deadlineExceeded) { yield { kind: "error", error: { code: "deadline_exceeded", message: "inference deadline exceeded" } }; return; } if (context.signal.aborted) { yield { kind: "error", error: { code: "cancelled", message: "inference cancelled" } }; return; } yield { kind: "error", error: { code: "inference_unavailable", message: error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[redacted-endpoint]") : "inference unavailable" } }; }
    finally {
      const cancelled = context.signal.aborted || deadlineExceeded;
      if(cancelled)parserTerminal=deadlineExceeded?'deadline':'cancelled';
      if(traceEnabled)trace('stream-shape',undefined,streamShape);
      trace(cancelled?'generation-ended-cancelled':'generation-ended');
      const detach=()=>{clearTimeout(deadlineTimer);context.signal.removeEventListener("abort",abort);controller.abort();};
      const cleanup = async (): Promise<void> => {
        try { await reader?.cancel().catch(() => {}); }
        finally {
          try { reader?.releaseLock(); } catch { /* Aborted or already released reader. */ }
          this.transportReservations--;
          trace('transport-released');
        }
      };
      if(responseCapture&&parserTerminal==='done'&&!cancelled&&reader){
        // Original DONE is already yielded. Reader ownership and its transport
        // reservation move to bounded deferred cleanup, never a new authority.
        // Keep the ORIGINAL timer/caller abort until EOF or explicit partial.
        this.deferTransportCleanup(async()=>{
          try{await drainCapture();}
          catch{parserTerminal=deadlineExceeded?'deadline':context.signal.aborted?'cancelled':'other';}
          finally{try{finishCapture();}catch{/* Closed private failure metadata. */}detach();await cleanup();}
        });
      }else{
        try{finishCapture();}catch{/* Closed private failure metadata. */}
        detach();
        // Existing cleanup ownership after cancellation remains unchanged.
        if(cancelled&&reader)this.deferTransportCleanup(cleanup);
        else await cleanup();
      }
    }
  }
}
