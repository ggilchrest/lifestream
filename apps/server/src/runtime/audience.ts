// Endpoint-scoped disclosure evidence. This does not identify speakers or grant authority.
export type AudienceIdentity={principalId:string;sessionId:string;endpointId:string|null};
export type AudienceObservation={sourceId:string;evidenceRef:string;endpointId:string;principalId:string;observedAt:string;expiresAt:string;coverageKnown:boolean;ownerPresent:boolean;occupants:number};
export type AudienceSnapshot={classification:'solo-supported'|'shared'|'unknown';basis:'automatic'|'manual'|'unavailable'|'restricted';revision:number;sourceId:string|null;evidenceRef:string|null;expiresAt:string|null;automatic:boolean;privateAllowed:boolean};
export type AudienceOptions={sourceIds?:string[];poll?:(identity:AudienceIdentity,signal:AbortSignal)=>Promise<AudienceObservation|null>;now?:()=>number};
type Entry={identity:AudienceIdentity;observation?:AudienceObservation|undefined;manual?:{mode:'solo'|'shared';expires:number}|undefined;restricted:boolean;revision:number;key:string;value:AudienceSnapshot;listeners:Set<(value:AudienceSnapshot)=>void>;touched:number;polling?:AbortController|undefined};
export class AudienceCoordinator{
 private readonly entries=new Map<string,Entry>();private readonly timer:ReturnType<typeof setInterval>;private readonly now:()=>number;
 private readonly options:AudienceOptions;private readonly changed:()=>void;
 constructor(options:AudienceOptions={},changed:()=>void=()=>{}){this.options=options;this.changed=changed;this.now=options.now??Date.now;this.timer=setInterval(()=>this.tick(),250);this.timer.unref();}
 private entry(identity:AudienceIdentity):Entry{const key=JSON.stringify(identity);let e=this.entries.get(key);if(!e){if(this.entries.size>=1000)throw new Error('Audience session capacity reached');const value:AudienceSnapshot={classification:'unknown',basis:'unavailable',revision:0,sourceId:null,evidenceRef:null,expiresAt:null,automatic:false,privateAllowed:false};e={identity:{...identity},restricted:false,revision:0,key:'',value,listeners:new Set(),touched:this.now()};this.entries.set(key,e);}e.touched=this.now();return e;}
 snapshot(identity:AudienceIdentity):AudienceSnapshot{return structuredClone(this.reconcile(this.entry(identity)));}
 declare(identity:AudienceIdentity,mode:'solo'|'shared'|'clear'|'lock'|'unlock',seconds=300):AudienceSnapshot{
  if(!['solo','shared','clear','lock','unlock'].includes(mode))throw new Error('Unsupported audience declaration');
  if(!Number.isInteger(seconds)||seconds<1||seconds>900)throw new Error('A manual declaration must expire within fifteen minutes');
  const e=this.entry(identity);if(mode==='lock'){e.restricted=true;e.manual=undefined;}else if(mode==='unlock'){e.restricted=false;e.manual=undefined;e.observation=undefined;}else if(mode==='clear')e.manual=undefined;else{if(!identity.endpointId)throw new Error('Open Session disclosure and apply a choice before declaring an audience');e.manual={mode,expires:this.now()+seconds*1000};}return structuredClone(this.reconcile(e));
 }
 // Only an operator-configured source adapter can publish automatic evidence.
 observe(identity:AudienceIdentity,input:AudienceObservation|null):void{this.applyObservation(this.entry(identity),input);}
 private applyObservation(e:Entry,input:AudienceObservation|null):void{e.observation=undefined;if(input&&this.valid(e.identity,input))e.observation=structuredClone(input);this.reconcile(e);}
 private valid(identity:AudienceIdentity,o:AudienceObservation):boolean{const now=this.now(),at=Date.parse(o.observedAt),expires=Date.parse(o.expiresAt);return !!identity.endpointId&&o.endpointId===identity.endpointId&&o.principalId===identity.principalId&&(this.options.sourceIds??[]).includes(o.sourceId)&&typeof o.evidenceRef==='string'&&o.evidenceRef.length>0&&o.evidenceRef.length<=256&&Number.isInteger(o.occupants)&&o.occupants>=0&&o.occupants<=100&&typeof o.coverageKnown==='boolean'&&typeof o.ownerPresent==='boolean'&&Number.isFinite(at)&&at<=now+500&&now-at<=5000&&Number.isFinite(expires)&&expires>now&&expires<=at+5000;}
 private reconcile(e:Entry):AudienceSnapshot{
  const now=this.now();if(e.manual&&e.manual.expires<=now)e.manual=undefined;if(e.observation&&!this.valid(e.identity,e.observation))e.observation=undefined;
  const o=e.observation,m=e.manual;let classification:AudienceSnapshot['classification']='unknown',basis:AudienceSnapshot['basis']='unavailable',expiresAt:string|null=null,sourceId:string|null=null,evidenceRef:string|null=null;
  if(e.restricted){basis='restricted';}
  else if(m?.mode==='shared'){classification='shared';basis='manual';expiresAt=new Date(m.expires).toISOString();}
  else if(o&&o.occupants>1){classification='shared';basis='automatic';expiresAt=o.expiresAt;sourceId=o.sourceId;evidenceRef=o.evidenceRef;}
  // Known automatic coverage can contradict a still-current manual solo declaration.
  else if(o&&o.coverageKnown){if(o.ownerPresent&&o.occupants===1)classification='solo-supported';basis='automatic';expiresAt=o.expiresAt;sourceId=o.sourceId;evidenceRef=o.evidenceRef;}
  else if(m?.mode==='solo'){classification='solo-supported';basis='manual';expiresAt=new Date(m.expires).toISOString();}
  const key=JSON.stringify([classification,basis,sourceId]);const changed=key!==e.key;e.key=key;if(changed)e.revision++;
  e.value={classification,basis,revision:e.revision,sourceId,evidenceRef,expiresAt,automatic:basis==='automatic',privateAllowed:classification==='solo-supported'};
  if(changed){this.changed();for(const fn of e.listeners)fn(structuredClone(e.value));}return e.value;
 }
 subscribe(identity:AudienceIdentity,fn:(value:AudienceSnapshot)=>void):()=>void{const e=this.entry(identity);if(e.listeners.size>=16)throw new Error('Too many audience subscribers');e.listeners.add(fn);fn(this.snapshot(identity));return ()=>e.listeners.delete(fn);}
 tick():void{const now=this.now();for(const [key,e]of this.entries){this.reconcile(e);if(!e.listeners.size&&now-e.touched>1800000){e.polling?.abort();this.entries.delete(key);continue;}if(this.options.poll&&e.identity.endpointId&&!e.polling){const controller=e.polling=new AbortController(),timeout=setTimeout(()=>controller.abort(),750);const promise=Promise.resolve().then(()=>this.options.poll!(e.identity,controller.signal));void Promise.race([promise,new Promise<null>(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}))]).then(value=>{if(this.entries.get(key)===e)this.applyObservation(e,value);},()=>{if(this.entries.get(key)===e)this.applyObservation(e,null);}).finally(()=>{clearTimeout(timeout);if(e.polling===controller)e.polling=undefined;});}}}
 close():void{clearInterval(this.timer);for(const e of this.entries.values())e.polling?.abort();this.entries.clear();}
}
