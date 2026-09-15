/** Volatile dialogue context, separate from durable memory and delivery accounting.
 * Only already accepted user text/transcripts and observed Assistant output enter it. */
export type ConversationScope={principalId:string;sessionId:string;conversationId:string;assistantId:string;relationshipId:string|null};
export type ConversationTurn={interactionId:string;role:'user'|'assistant';text:string;opportunityId?:string;observation?:'emitted'};
export type ConversationPort={read:()=>string;remember:(turn:ConversationTurn)=>void};
type Entry={turn:ConversationTurn&{truncated?:boolean};current:()=>boolean;expiresAt:number;order:number};
type Bucket=Map<string,Entry>;
export const conversationLimits={scopes:32,entries:128,entriesPerScope:20,bytesPerScope:65536,totalBytes:524288,entryCharacters:16000,ttlMs:1800000} as const;
export class ConversationHistory {
 private readonly scopes=new Map<string,Bucket>();private sequence=0;private clock=0;private expiryTimer:ReturnType<typeof setTimeout>|undefined;
 private readonly now:()=>number;
 constructor(now=Date.now){this.now=now;}
 private time(){this.clock=Math.max(this.clock,this.now());return this.clock;}
 private valid(current:()=>boolean){try{return current()===true;}catch{return false;}}
 private project(bucket:Bucket){return [...bucket.values()].map(entry=>entry.turn);}
 private bytes(bucket:Bucket){return Buffer.byteLength(JSON.stringify(this.project(bucket)),'utf8');}
 prune():void{const now=this.time();for(const [key,bucket] of this.scopes){for(const [id,entry] of bucket)if(entry.expiresAt<=now||!this.valid(entry.current))bucket.delete(id);if(!bucket.size)this.scopes.delete(key);}this.schedule();}
 private schedule(){clearTimeout(this.expiryTimer);this.expiryTimer=undefined;let next=Infinity;for(const bucket of this.scopes.values())for(const entry of bucket.values())next=Math.min(next,entry.expiresAt);if(Number.isFinite(next)){this.expiryTimer=setTimeout(()=>{this.expiryTimer=undefined;this.prune();},Math.max(1,next-this.time()));this.expiryTimer.unref?.();}}
 clear():void{clearTimeout(this.expiryTimer);this.expiryTimer=undefined;this.scopes.clear();}
 diagnostics(){return {scopes:this.scopes.size,entries:[...this.scopes.values()].reduce((n,b)=>n+b.size,0),bytes:[...this.scopes.values()].reduce((n,b)=>n+this.bytes(b),0)};}
 bind(scope:ConversationScope,current:()=>boolean,expiresAt:number):ConversationPort{
  const key=JSON.stringify([scope.principalId,scope.sessionId,scope.conversationId,scope.assistantId,scope.relationshipId]);let retired=false;const admitted=()=>{if(retired)return false;if(!this.valid(current)){retired=true;return false;}return true;};
  return {read:()=>{this.prune();if(!admitted()||expiresAt<=this.time())return '[]';const bucket=this.scopes.get(key);return bucket?JSON.stringify(this.project(bucket)):'[]';},remember:turn=>{
   this.prune();const now=this.time();if(!admitted()||!Number.isFinite(expiresAt)||expiresAt<=now||!turn.text)return;
   const id=JSON.stringify([turn.interactionId,turn.role]),bucket=this.scopes.get(key)??new Map<string,Entry>(),previous=bucket.get(id);
   bucket.set(id,{turn:{...turn,text:turn.text.slice(0,conversationLimits.entryCharacters),...(turn.text.length>conversationLimits.entryCharacters?{truncated:true}:{})},current:admitted,expiresAt:Math.min(previous?.expiresAt??Infinity,expiresAt,now+conversationLimits.ttlMs),order:previous?.order??++this.sequence});this.scopes.set(key,bucket);
   while(bucket.size>conversationLimits.entriesPerScope||this.bytes(bucket)>conversationLimits.bytesPerScope)bucket.delete(bucket.keys().next().value!);
   while(this.scopes.size>conversationLimits.scopes||this.diagnostics().entries>conversationLimits.entries||this.diagnostics().bytes>conversationLimits.totalBytes){let oldest:{bucket:Bucket;id:string;order:number}|undefined;for(const b of this.scopes.values())for(const [entryId,entry] of b)if(!oldest||entry.order<oldest.order)oldest={bucket:b,id:entryId,order:entry.order};if(!oldest)break;oldest.bucket.delete(oldest.id);for(const [scopeKey,b] of this.scopes)if(!b.size)this.scopes.delete(scopeKey);}
   if(!bucket.size)this.scopes.delete(key);this.schedule();
  }};
 }
}
