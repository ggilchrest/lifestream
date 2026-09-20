import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {AcknowledgmentRepository,type Database,type AcknowledgmentArtifact,type AcknowledgmentCatalog,type AcknowledgmentClip,type AcknowledgmentTrack} from '@lifestream/storage-sqlite';
import type {BackgroundWork,BackgroundResult} from '@lifestream/runtime/understanding/coordinator';
import type {VoiceBinding} from '../admin/saved-voices.ts';

const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export type AcknowledgmentVoice=VoiceBinding&{binding:string};
export type AcknowledgmentAlignment={cueSet:string;analysisRevision:string;cues:readonly string[];align:(audio:Uint8Array,metadata:AcknowledgmentArtifact,signal:AbortSignal)=>Promise<AcknowledgmentTrack>};
export type AcknowledgmentHost={voice:(assistantId:string)=>AcknowledgmentVoice;propose:(voice:AcknowledgmentVoice,signal:AbortSignal)=>Promise<string[]>;synthesize:(text:string,voice:AcknowledgmentVoice,signal:AbortSignal)=>Promise<Uint8Array>;run:<T>(work:BackgroundWork<T>)=>Promise<BackgroundResult>;priority:()=>{preemptionBoundMs:number;slotReleaseBoundMs:number}|undefined;alignment?:()=>AcknowledgmentAlignment|undefined;requiresSync?:()=>boolean;now?:()=>number};

export function validateAcknowledgmentTrack(value:unknown,audio:AcknowledgmentArtifact,alignment:Pick<AcknowledgmentAlignment,'cueSet'|'analysisRevision'|'cues'>):AcknowledgmentTrack {
  const t=value as AcknowledgmentTrack;
  if(!t||t.schemaVersion!=='1.0.0'||t.cueSet!==alignment.cueSet||t.analysisRevision!==alignment.analysisRevision||t.timeUnit!=='ms'||t.timeOrigin!=='audio-start'||t.audioSha256!==audio.sha256||t.durationMs!==audio.durationMs||!Array.isArray(t.cues)||!t.cues.length||t.cues.length>600)throw new Error('Incompatible acknowledgment alignment.');
  let end=0;
  for(const cue of t.cues){if(!Number.isFinite(cue.startMs)||!Number.isFinite(cue.endMs)||cue.startMs<end||cue.endMs<=cue.startMs||cue.endMs>audio.durationMs||!alignment.cues.includes(cue.cue))throw new Error('Invalid acknowledgment cue timing.');end=cue.endMs;}
  return t;
}
export function acknowledgmentPhrases(values:unknown,existing:readonly string[]=[]):string[]{
  if(!Array.isArray(values)||values.length>20)throw new Error('Expected a bounded phrase batch.');
  const seen=new Set(existing.map(x=>x.toLowerCase()));
  return values.filter((text):text is string=>{
    if(typeof text!=='string'||text!==text.trim()||!text||text.length>100||text.split(/\s+/).length>8||/[\d\n\r{}<>\[\]()]/.test(text)||!/[.!?]$/.test(text))return false;
    // A cue cannot announce action success or promise future work. The proposal
    // prompt supplies no user facts, history, tasks or tool state.
    if(/\b(done|completed|sent|saved|booked|ordered|promise|remember|you said|your|always|forever)\b/i.test(text)||seen.has(text.toLowerCase()))return false;
    // Constrain the LLM batch to acknowledgment intents rather than trusting a
    // short sentence to be context-independent merely because it is short.
    if(!/^(?:I(?: am|'m|’m) (?:listening|following)(?: (?:closely|along))?|Let me (?:think|consider)(?: (?:about that|that|this|it))?|(?:One|Just a) moment|Hmm|I see|I hear you|All right|Okay|Understood|Thanks for sharing|Got it|Give me a moment|Let me take a look|Let me take a moment)[.!]$/i.test(text))return false;
    seen.add(text.toLowerCase());return true;
  });
}

/** Bounded in-process upkeep. Existing shared background admission owns priority;
 * no work, synthesis or artifact read is admitted by a spoken turn. */
export class AcknowledgmentCatalogService {
  readonly repository: AcknowledgmentRepository;
  private readonly directory:string;
  private readonly host:AcknowledgmentHost;
  private active:Promise<void>|undefined;
  private closed=false;
  private readonly pending=new Set<string>();
  private timer:ReturnType<typeof setInterval>|undefined;
  private controller:AbortController|undefined;
  readonly outcomes=new Map<string,string>();
  private readonly published=new Map<string,{revision:number;binding:string;clipIds:string[]}>();
  constructor(database:Database,directory:string,host:AcknowledgmentHost){this.repository=new AcknowledgmentRepository(database);this.directory=join(directory,'acknowledgments');this.host=host;}
  private now(){return this.host.now?.()??Date.now();}
  current(assistantId:string){const voice=this.host.voice(assistantId);return {voice,catalog:this.repository.ensure(assistantId,voice.binding)};}
  private path(sha:string){if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('Invalid artifact identity.');return join(this.directory,sha);}
  async bytes(sha:string,maximum=288000){const bytes=await readFile(this.path(sha));if(bytes.length>maximum||digest(bytes)!==sha)throw new Error('Acknowledgment artifact is unavailable or corrupt.');return bytes;}
  private async put(bytes:Uint8Array){const sha=digest(bytes);await mkdir(this.directory,{recursive:true,mode:0o700});try{await writeFile(this.path(sha),bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;try{await this.bytes(sha);}catch{const temporary=join(this.directory,randomUUID()+'.tmp');try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,this.path(sha));}finally{await unlink(temporary).catch(()=>{});}}}return sha;}
  private async valid(clip:AcknowledgmentClip){try{const bytes=await this.bytes(clip.audio.sha256);return bytes.length===clip.audio.bytes&&bytes.length%2===0&&bytes.length/96===clip.audio.durationMs&&clip.audio.durationMs>0&&clip.audio.durationMs<=3000;}catch{return false;}}
  private async paired(clip:AcknowledgmentClip){const alignment=this.host.alignment?.();if(!alignment||!clip.visemes)return false;try{const bytes=await this.bytes(clip.visemes.sha256);if(bytes.length!==clip.visemes.bytes)return false;validateAcknowledgmentTrack(JSON.parse(bytes.toString()),clip.audio,alignment);return true;}catch{return false;}}
  async manifest(assistantId:string){
    const {catalog}=this.current(assistantId),clips=[];
    for(const clip of catalog.clips){if(!await this.valid(clip))continue;const synchronized=await this.paired(clip);clips.push({...clip,synchronized,visemes:synchronized?clip.visemes:null});}
    if(this.repository.get(assistantId)?.revision!==catalog.revision)throw new Error('Catalog changed during manifest preparation.');
    this.published.set(assistantId,{revision:catalog.revision,binding:catalog.binding,clipIds:clips.map(c=>c.id)});
    return {schemaVersion:'1.0.0',assistantId,revision:catalog.revision,binding:catalog.binding,enabled:catalog.enabled,defaultTtlDays:catalog.defaultTtlDays,readyCount:clips.length,synchronizedReadyCount:clips.filter(c=>c.synchronized).length,alignment:this.host.alignment?.()?'configured':'unavailable',maintenance:this.outcomes.get(assistantId)??'not-run',clips};
  }
  eligible(assistantId:string){const {catalog}=this.current(assistantId),known=this.published.get(assistantId);return catalog.enabled&&known?.revision===catalog.revision&&known.binding===catalog.binding?known:null;}
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.maintain();},3600000);this.timer.unref();void this.maintain();}
  close(){this.closed=true;if(this.timer)clearInterval(this.timer);this.controller?.abort();}
  maintain(assistantId?:string):Promise<void>{
    if(this.closed)return Promise.resolve();if(this.active){if(assistantId)this.pending.add(assistantId);return this.active;}
    const ids=assistantId?[assistantId]:this.repository.enabled();
    this.active=(async()=>{for(const id of ids){if(this.closed)break;try{await this.upkeep(id);}catch{this.outcomes.set(id,'failed; retained usable clips');}}if(!this.closed)await this.cleanup();})().catch(()=>{}).finally(()=>{this.active=undefined;const next=this.pending.values().next().value;if(next&&!this.closed){this.pending.delete(next);void this.maintain(next);}});return this.active;
  }
  private async cleanup(){
    // Membership may change while bytes are prepared. Keep freshly orphaned data
    // until the next bounded pass; unreferenced artifacts are never served.
    const live=new Set<string>();for(const id of this.repository.enabled())for(const c of this.repository.get(id)?.clips??[]){live.add(c.audio.sha256);if(c.visemes)live.add(c.visemes.sha256);}
    // Disabled catalogs retain favorites; include their membership as well.
    // The host supplies all persisted membership through this repository helper.
    for(const sha of this.repository.artifacts())live.add(sha);
    let names:string[];try{names=await readdir(this.directory);}catch{return;}
    for(const name of names.slice(0,2048)){if(/^[a-f0-9]{64}$/.test(name)&&!live.has(name))await unlink(this.path(name)).catch(()=>{});}
  }
  private async upkeep(id:string){
    let {voice,catalog}=this.current(id);if(!catalog.enabled)return;
    const binding=voice.binding,current=()=>!this.closed&&voice.current()&&this.host.voice(id).binding===binding&&this.repository.get(id)?.enabled===true;
    const valid: AcknowledgmentClip[]=[];for(const clip of catalog.clips)if(await this.valid(clip))valid.push(clip);
    if(valid.length!==catalog.clips.length)catalog=this.repository.update(id,catalog.revision,c=>{c.clips=valid;});
    let proposed:string[]|undefined;
    const run=async<T>(job:(signal:AbortSignal)=>Promise<T>,publish:(value:T)=>boolean)=>{
      const controller=this.controller=new AbortController(),bounds=this.host.priority();
      const result=await this.host.run({key:'acknowledgment:'+id,deadlineAt:this.now()+45000,current,admitOnce:()=>current(),sharedInference:true,...(bounds?{providerPreemptionBoundMs:bounds.preemptionBoundMs,providerSlotReleaseBoundMs:bounds.slotReleaseBoundMs}:{}),priority:'P2',steps:[signal=>job(AbortSignal.any([signal,controller.signal]))],publish});
      if(this.controller===controller)this.controller=undefined;this.outcomes.set(id,result.reason);return result.state==='published';
    };
    const align=async(clip:AcknowledgmentClip,signal:AbortSignal)=>{const alignment=this.host.alignment?.();if(!alignment)return clip;const track=validateAcknowledgmentTrack(await alignment.align(await this.bytes(clip.audio.sha256),clip.audio,signal),clip.audio,alignment),bytes=Buffer.from(JSON.stringify(track));return {...clip,visemes:{sha256:await this.put(bytes),bytes:bytes.length,cueSet:track.cueSet,analysisRevision:track.analysisRevision}};};
    // Repair only the paired track. Creation/expiry and final audio stay intact.
    for(const original of catalog.clips){if(!this.host.alignment?.()||await this.paired(original))continue;const success=await run(signal=>align(original,signal),clip=>{const next=this.repository.get(id);if(!current()||!next||next.binding!==binding)return false;const old=next.clips.find(c=>c.id===original.id);if(!old||old.audio.sha256!==original.audio.sha256)return false;this.repository.update(id,next.revision,c=>{const member=c.clips.find(c=>c.id===old.id)!;if(clip.visemes)member.visemes=clip.visemes;else delete member.visemes;member.revision++;});return true;});if(!success)return;}
    const prepare=async(signal:AbortSignal)=>{
      const existing=this.repository.get(id)?.clips.map(c=>c.text)??[];
      proposed??=acknowledgmentPhrases(await this.host.propose(voice,signal),existing);
      const text=proposed.shift();if(!text)throw new Error('No distinct context-independent phrases available.');
      const bytes=await this.host.synthesize(text,voice,signal);if(!bytes.length||bytes.length%2||bytes.length>288000)throw new Error('Acknowledgment must contain complete audio no longer than three seconds.');
      const now=this.now(),ttl=this.repository.get(id)!.defaultTtlDays,clip:AcknowledgmentClip={id:randomUUID(),revision:1,text,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+ttl*86400000).toISOString(),audio:{sha256:await this.put(bytes),bytes:bytes.length,format:'pcm_s16le',sampleRateHz:48000,channels:1,durationMs:bytes.length/96}};
      try{return await align(clip,signal);}catch(error){if(this.host.requiresSync?.())throw error;return clip;}
    };
    for(let attempt=0;attempt<5;attempt++){
      catalog=this.repository.get(id)!;if(catalog.clips.length>=5)break;
      const success=await run(prepare,clip=>{const next=this.repository.get(id);if(!current()||!next||next.binding!==binding||next.clips.length>=5)return false;this.repository.update(id,next.revision,c=>{c.clips.push(clip);});return true;});if(!success)return;
    }
    catalog=this.repository.get(id)!;const day=new Date(this.now()).toISOString().slice(0,10);
    if(catalog.clips.length<5||catalog.lastSweepDay===day)return;
    const oldest=catalog.clips.filter(c=>c.expiresAt!==null&&Date.parse(c.expiresAt)<=this.now()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];if(!oldest)return;
    await run(prepare,clip=>{const next=this.repository.get(id);if(!current()||!next||next.binding!==binding||next.lastSweepDay===day||next.clips.length<5)return false;const target=next.clips.find(c=>c.id===oldest.id);if(!target||target.revision!==oldest.revision||target.expiresAt===null||Date.parse(target.expiresAt)>this.now())return false;
      if(this.host.requiresSync?.()&&!clip.visemes)return false;
      this.repository.update(id,next.revision,c=>{c.clips=c.clips.map(c=>c.id===oldest.id?clip:c);c.lastSweepDay=day;});return true;});
  }
}
