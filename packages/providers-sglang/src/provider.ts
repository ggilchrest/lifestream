import type { InferenceChunk, InferenceProvider, InferenceRequest, ProviderCallContext } from "@lifestream/runtime/inference";
import { createHash } from "node:crypto";

const canonicalKinds = ["policy", "corePersona", "adaptivePersona", "interactionState", "preparedMemory", "worldContext", "capabilityState", "conversation", "userInput"];
const validCanonicalRequest = (request: InferenceRequest): boolean => {
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

export type SglangConfig = { endpoint: string; model: string; protocol?: "sglang" | "llama.cpp"; apiKey?: string; maxResponseBytes?: number };

export class SglangInferenceProvider implements InferenceProvider {
  private readonly config: SglangConfig;
  constructor(config: SglangConfig) { this.config = config; }
  async tokenize(input:InferenceRequest|string,context:ProviderCallContext):Promise<{count:number;identity:string}>{
    if(typeof input!=='string'&&(!validCanonicalRequest(input)||input.executionMode==='replay'))throw Error('Invalid tokenization request.');
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
  }
  private chatBody(request:InferenceRequest){return {model:this.config.model,stream:true,...(request.maximumOutputTokens===undefined?{}:{max_tokens:request.maximumOutputTokens}),...(directRequest(request)?{chat_template_kwargs:{enable_thinking:false}}:{}),messages:messagesFor(request)};}
  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> {
    if (request.executionMode === "replay") { yield { kind: "error", error: { code: "replay_live_provider_forbidden", message: "live inference is unavailable during replay" } }; return; }
    if (!validCanonicalRequest(request)) { yield { kind: "error", error: { code: "invalid_canonical_request", message: "inference requires the ordered canonical sections and matching trusted-source manifest" } }; return; }
    const remainingMs = Date.parse(request.deadlineAt) - Date.now();
    if (remainingMs <= 0) { yield { kind: "error", error: { code: "deadline_exceeded", message: "inference deadline exceeded" } }; return; }
    const controller = new AbortController(); const abort = () => controller.abort(context.signal.reason); context.signal.addEventListener("abort", abort, { once: true });
    if(context.signal.aborted)controller.abort(context.signal.reason);
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => { deadlineExceeded = true; controller.abort(); }, Math.min(remainingMs, 2_147_483_647));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Runtime-owned typed and spoken prompts select the supported direct-answer mode.
      // This is a per-request mapping; untrusted text cannot change decoding or deadlines.
      const response = await fetch(`${this.config.endpoint.replace(/\/$/u, "")}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: JSON.stringify(this.chatBody(request)), signal: controller.signal });
      if (!response.ok || !response.body) { yield { kind: "error", error: { code: "inference_unavailable", message: `inference service returned HTTP ${response.status}` } }; return; }
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let emitted = 0; const max = this.config.maxResponseBytes ?? 64_000;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines=buffer.split('\n');buffer=lines.pop()??'';
        if(Buffer.byteLength(buffer)>max){yield {kind:'error',error:{code:'response_limit',message:'inference stream frame limit exceeded'}};return;}
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { yield { kind: "done" }; return; }
          try {
            const choice=JSON.parse(data)?.choices?.[0];
            if(choice?.finish_reason==='length'){yield {kind:'error',error:{code:'response_limit',message:'inference provider reached its generation limit'}};return;}
            const text = choice?.delta?.content;
            if (typeof text === "string" && text.length) { emitted += Buffer.byteLength(text); if (emitted > max) { yield { kind: "error", error: { code: "response_limit", message: "inference response limit exceeded" } }; return; } yield { kind: "text", text }; }
          } catch { yield { kind: "error", error: { code: "malformed_provider_event", message: "inference provider returned malformed stream data" } }; return; }
        }
      }
      yield { kind: "error", error:{code:'malformed_provider_event',message:'inference stream ended without a terminal event'} };
    } catch (error) { if (deadlineExceeded) { yield { kind: "error", error: { code: "deadline_exceeded", message: "inference deadline exceeded" } }; return; } if (context.signal.aborted) { yield { kind: "error", error: { code: "cancelled", message: "inference cancelled" } }; return; } yield { kind: "error", error: { code: "inference_unavailable", message: error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[redacted-endpoint]") : "inference unavailable" } }; }
    finally { clearTimeout(deadlineTimer); context.signal.removeEventListener("abort", abort);controller.abort();await reader?.cancel().catch(()=>{});reader?.releaseLock(); }
  }
}
