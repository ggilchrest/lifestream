/** Volatile dialogue context, separate from durable memory and delivery accounting.
 * Only already accepted user text/transcripts and observed Assistant output enter it. */
export type ConversationScope={principalId:string;sessionId:string;conversationId:string;assistantId:string;relationshipId:string|null};
export type ConversationTurn={interactionId:string;role:'user'|'assistant';text:string;opportunityId?:string;observation?:'emitted'};
export type ConversationPort={read:()=>string;remember:(turn:ConversationTurn)=>void};
type Entry={turn:ConversationTurn&{truncated?:boolean};current:()=>boolean;expiresAt:number;order:number};
type Bucket=Map<string,Entry>;
export type ConversationTransfer=Readonly<{scope:Readonly<ConversationScope>;content:string;entries:number;expiresAt:number}>;
export const conversationLimits={scopes:32,entries:128,entriesPerScope:20,bytesPerScope:65536,totalBytes:524288,entryCharacters:16000,ttlMs:1800000} as const;
export class ConversationHistory {
 private readonly scopes=new Map<string,Bucket>();private sequence=0;private clock=0;private expiryTimer:ReturnType<typeof setTimeout>|undefined;
 private readonly now:()=>number;
 private transferGeneration=0;
 private readonly transfers=new WeakMap<ConversationTransfer,{key:string;entries:Array<[string,Entry]>;used:boolean;generation:number}>();
 constructor(now=Date.now){this.now=now;}
 private time(){this.clock=Math.max(this.clock,this.now());return this.clock;}
 private valid(current:()=>boolean){try{return current()===true;}catch{return false;}}
 private project(bucket:Bucket){return [...bucket.values()].map(entry=>entry.turn);}
 private bytes(bucket:Bucket){return Buffer.byteLength(JSON.stringify(this.project(bucket)),'utf8');}
 prune():void{const now=this.time();for(const [key,bucket] of this.scopes){for(const [id,entry] of bucket)if(entry.expiresAt<=now||!this.valid(entry.current))bucket.delete(id);if(!bucket.size)this.scopes.delete(key);}this.schedule();}
 private schedule(){clearTimeout(this.expiryTimer);this.expiryTimer=undefined;let next=Infinity;for(const bucket of this.scopes.values())for(const entry of bucket.values())next=Math.min(next,entry.expiresAt);if(Number.isFinite(next)){this.expiryTimer=setTimeout(()=>{this.expiryTimer=undefined;this.prune();},Math.max(1,next-this.time()));this.expiryTimer.unref?.();}}
 clear():void{clearTimeout(this.expiryTimer);this.expiryTimer=undefined;this.scopes.clear();this.transferGeneration++;}
 diagnostics(){return {scopes:this.scopes.size,entries:[...this.scopes.values()].reduce((n,b)=>n+b.size,0),bytes:[...this.scopes.values()].reduce((n,b)=>n+this.bytes(b),0)};}
 /** Host-only prepared boundary. It is neither a transferable grant nor durable memory. */
 prepareTransfer(scope:ConversationScope):ConversationTransfer{
  this.prune();const key=JSON.stringify([scope.principalId,scope.sessionId,scope.conversationId,scope.assistantId,scope.relationshipId]),bucket=this.scopes.get(key)??new Map<string,Entry>();
  const boundary=Object.freeze({scope:Object.freeze({...scope}),content:JSON.stringify(this.project(bucket)),entries:bucket.size,expiresAt:Math.min(Infinity,...[...bucket.values()].map(entry=>entry.expiresAt))});
  this.transfers.set(boundary,{key,entries:[...bucket.entries()],used:false,generation:this.transferGeneration});return boundary;
 }
 transferCurrent(boundary:ConversationTransfer):boolean{
  const saved=this.transfers.get(boundary);if(!saved||saved.used||saved.generation!==this.transferGeneration)return false;const current=this.scopes.get(saved.key),now=this.time();
  return (current?.size??0)===saved.entries.length&&saved.entries.every(([id,entry])=>current?.get(id)===entry&&entry.expiresAt>now&&this.valid(entry.current));
 }
 /** Run a synchronous durable transaction with install inside it; restore volatile
  * state if that transaction fails. The host must separately check destination
  * consent, inactivity, endpoint/audio fencing and current administration authority. */
 withTransfer(boundary:ConversationTransfer,destination:ConversationScope,expiresAt:number,transaction:(install:(current:()=>boolean)=>void)=>void):void{
  if(!this.transferCurrent(boundary))throw Error('Conversation boundary changed');
  const source=boundary.scope;
  if(source.sessionId===destination.sessionId||['principalId','conversationId','assistantId','relationshipId'].some(k=>source[k as keyof ConversationScope]!==destination[k as keyof ConversationScope]))throw Error('Conversation transfer scope mismatch');
  if([...this.scopes.keys()].some(key=>JSON.parse(key)[1]===destination.sessionId))throw Error('Destination already has conversation history');
  if(!Number.isFinite(expiresAt)||expiresAt<=this.time())throw Error('Destination has expired');
  const saved=this.transfers.get(boundary)!,prior=new Map([...this.scopes].map(([key,bucket])=>[key,new Map(bucket)]));let installed=false;
  try{
   transaction(current=>{
    if(installed||!this.valid(current))throw Error('Destination conversation is unavailable');installed=true;
    let retired=false;const admitted=()=>{if(retired)return false;if(!this.valid(current)){retired=true;return false;}return true;};
    const key=JSON.stringify([destination.principalId,destination.sessionId,destination.conversationId,destination.assistantId,destination.relationshipId]);
    if(saved.entries.length)this.scopes.set(key,new Map(saved.entries.map(([id,entry])=>[id,{...entry,turn:structuredClone(entry.turn),current:admitted,expiresAt:Math.min(entry.expiresAt,expiresAt)}])));
    // Do not prune here: the enclosing database transaction may temporarily end
    // the source and then roll back. Pruning would irreversibly retire its guards.
   });
   if(!installed)throw Error('Conversation was not installed');saved.used=true;
  }catch(error){this.scopes.clear();for(const [key,bucket] of prior)this.scopes.set(key,bucket);this.schedule();throw error;}
  this.prune();this.trim();this.schedule();
 }
 private trim():void{
  while(this.scopes.size>conversationLimits.scopes||this.diagnostics().entries>conversationLimits.entries||this.diagnostics().bytes>conversationLimits.totalBytes){let oldest:{bucket:Bucket;id:string;order:number}|undefined;for(const b of this.scopes.values())for(const [entryId,entry] of b)if(!oldest||entry.order<oldest.order)oldest={bucket:b,id:entryId,order:entry.order};if(!oldest)break;oldest.bucket.delete(oldest.id);for(const [scopeKey,b] of this.scopes)if(!b.size)this.scopes.delete(scopeKey);}
 }
 bind(scope:ConversationScope,current:()=>boolean,expiresAt:number):ConversationPort{
  const key=JSON.stringify([scope.principalId,scope.sessionId,scope.conversationId,scope.assistantId,scope.relationshipId]);let retired=false;const admitted=()=>{if(retired)return false;if(!this.valid(current)){retired=true;return false;}return true;};
  return {read:()=>{this.prune();if(!admitted()||expiresAt<=this.time())return '[]';const bucket=this.scopes.get(key);return bucket?JSON.stringify(this.project(bucket)):'[]';},remember:turn=>{
   this.prune();const now=this.time();if(!admitted()||!Number.isFinite(expiresAt)||expiresAt<=now||!turn.text)return;
   const id=JSON.stringify([turn.interactionId,turn.role]),bucket=this.scopes.get(key)??new Map<string,Entry>(),previous=bucket.get(id);
   bucket.set(id,{turn:{...turn,text:turn.text.slice(0,conversationLimits.entryCharacters),...(turn.text.length>conversationLimits.entryCharacters?{truncated:true}:{})},current:admitted,expiresAt:Math.min(previous?.expiresAt??Infinity,expiresAt,now+conversationLimits.ttlMs),order:previous?.order??++this.sequence});this.scopes.set(key,bucket);
   while(bucket.size>conversationLimits.entriesPerScope||this.bytes(bucket)>conversationLimits.bytesPerScope)bucket.delete(bucket.keys().next().value!);
   this.trim();
   if(!bucket.size)this.scopes.delete(key);this.schedule();
  }};
 }
}
