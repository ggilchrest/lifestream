import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Database } from '@lifestream/storage-sqlite';

export type PresentationManifest = {
  schemaVersion: '1.0.0' | '1.1.0' | '1.2.0' | '1.3.0' | '1.4.0'; id: string; version: string; label: string; renderer: 'three-glb.v1';
  model: string; resources: { path: string; sha256: string; bytes: number; mime: string }[];
  framing: { distance: number; targetHeight: number; yaw?: number; motionAnchor?: string }; animations: { idle?: string; listening?: string; preparing?: string; speaking?: string; interrupted?: string; working?: string; waiting?: string; failure?: string; mouthAmplitude?: string };
  animationLibrary?: {clip: string; label: string; group?: string; blendMode?: 'normal' | 'additive'}[];
  replaces?: string[];
  transitionSeconds?: number;
  face?: { gaze?: { nodes: {node:string;yawAxis:number[];pitchAxis:number[]}[];yawLimit:number;pitchLimit:number };blink?: {clip:string;periodSeconds:number;durationSeconds:number} };
  mouth?: { node: string; morph: string; gain: number };
  speech?: {cueSet:string;poses:Record<string,string>;transitionSeconds?:number};
  capabilities: { lipSync: 'none' | 'amplitude'; facialAnimation: boolean };
  fallback: 'neutral';
};
const identifier = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const assetPath = /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,239}\.(?:gltf|glb|bin|png|jpg|jpeg|webp)$/u;
const mimes = new Set(['model/gltf+json', 'model/gltf-binary', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp']);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid presentation data');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported presentation field');
}
function short(value: unknown, max = 128): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f<>]/u.test(value); }
export function validatePresentation(value: unknown): PresentationManifest {
  const m = object(value); keys(m, ['schemaVersion','id','version','label','renderer','model','resources','framing','animations','mouth','capabilities','fallback',...(['1.1.0','1.2.0','1.3.0','1.4.0'].includes(String(m.schemaVersion))?['transitionSeconds']:[]),...(['1.2.0','1.3.0','1.4.0'].includes(String(m.schemaVersion))?['face']:[]),...(['1.3.0','1.4.0'].includes(String(m.schemaVersion))?['speech']:[]),...(m.schemaVersion==='1.4.0'?['animationLibrary','replaces']:[])]);
  if (!['1.0.0','1.1.0','1.2.0','1.3.0','1.4.0'].includes(String(m.schemaVersion)) || !identifier.test(String(m.id)) || !short(m.version,32) || !short(m.label,80) || m.renderer !== 'three-glb.v1' || m.fallback !== 'neutral') throw new Error('Unsupported presentation manifest');
  if (!Array.isArray(m.resources) || !m.resources.length || m.resources.length > 256) throw new Error('Presentation resource bound exceeded');
  const paths = new Set<string>(); let total = 0;
  for (const resource of m.resources) {
    const r = object(resource); keys(r,['path','sha256','bytes','mime']);
    if (typeof r.path !== 'string' || !assetPath.test(r.path) || r.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(r.path) || !/^[a-f0-9]{64}$/u.test(String(r.sha256)) || !Number.isSafeInteger(r.bytes) || Number(r.bytes) < 1 || Number(r.bytes) > 192 * 1024 * 1024 || !mimes.has(String(r.mime))) throw new Error('Invalid presentation resource');
    paths.add(r.path); total += Number(r.bytes);
  }
  if (total > 384 * 1024 * 1024 || typeof m.model !== 'string' || !paths.has(m.model) || !/\.(glb|gltf)$/u.test(m.model)) throw new Error('Presentation model or size is invalid');
  const frame = object(m.framing); keys(frame,['distance','targetHeight','yaw',...(m.schemaVersion==='1.4.0'?['motionAnchor']:[])]);
  if(frame.motionAnchor!==undefined&&!short(frame.motionAnchor))throw new Error('Invalid motion anchor');
  if(frame.yaw!==undefined&&(typeof frame.yaw!=='number'||!Number.isFinite(frame.yaw)||Math.abs(frame.yaw)>Math.PI))throw new Error('Invalid presentation orientation');
  if (typeof frame.distance !== 'number' || !Number.isFinite(frame.distance) || frame.distance < 0.5 || frame.distance > 4 || typeof frame.targetHeight !== 'number' || !Number.isFinite(frame.targetHeight) || frame.targetHeight < 0 || frame.targetHeight > 1) throw new Error('Invalid presentation framing');
  const animations = object(m.animations); keys(animations,['idle','listening','speaking','mouthAmplitude',...(['1.1.0','1.2.0','1.3.0','1.4.0'].includes(String(m.schemaVersion))?['preparing','interrupted','working','waiting','failure']:[])]);
  if (Object.values(animations).some(value => !short(value))) throw new Error('Invalid semantic animation mapping');
  if(m.transitionSeconds!==undefined&&(typeof m.transitionSeconds!=='number'||!Number.isFinite(m.transitionSeconds)||m.transitionSeconds<0||m.transitionSeconds>1))throw new Error('Invalid animation transition duration');
  if(m.animationLibrary!==undefined){
    if(!Array.isArray(m.animationLibrary)||m.animationLibrary.length>128)throw new Error('Invalid animation library bound');
    const names=new Set();for(const entry of m.animationLibrary){const clip=object(entry);keys(clip,['clip','label','group','blendMode']);if(!short(clip.clip)||!short(clip.label,80)||clip.group!==undefined&&!short(clip.group,40)||clip.blendMode!==undefined&&!['normal','additive'].includes(String(clip.blendMode))||names.has(clip.clip))throw new Error('Invalid animation library entry');names.add(clip.clip);}
  }
  if(m.replaces!==undefined&&(!Array.isArray(m.replaces)||m.replaces.length>16||m.replaces.some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/u.test(hash))||new Set(m.replaces).size!==m.replaces.length))throw new Error('Invalid presentation replacement digest');
  const capabilities = object(m.capabilities); keys(capabilities,['lipSync','facialAnimation']);
  if (!['none','amplitude'].includes(String(capabilities.lipSync)) || typeof capabilities.facialAnimation !== 'boolean') throw new Error('Invalid presentation capabilities');
  if (m.mouth !== undefined) { const mouth = object(m.mouth); keys(mouth,['node','morph','gain']); if (!short(mouth.node) || !short(mouth.morph) || typeof mouth.gain !== 'number' || !Number.isFinite(mouth.gain) || mouth.gain < 0 || mouth.gain > 4 || capabilities.lipSync !== 'amplitude') throw new Error('Invalid mouth mapping'); }
  if(m.speech!==undefined){
   const speech=object(m.speech);keys(speech,['cueSet','poses','transitionSeconds']);const poses=object(speech.poses);
   if(!short(speech.cueSet)||capabilities.lipSync!=='amplitude'||!m.mouth&&!animations.mouthAmplitude||!Object.keys(poses).length||Object.keys(poses).length>32||Object.entries(poses).some(([cue,clip])=>!/^[A-Za-z0-9_-]{1,32}$/.test(cue)||!short(clip)))throw Error('Invalid speech cue mapping');
   if(speech.transitionSeconds!==undefined&&(typeof speech.transitionSeconds!=='number'||!Number.isFinite(speech.transitionSeconds)||speech.transitionSeconds<0||speech.transitionSeconds>.1))throw Error('Invalid speech transition duration');
  }
  if(m.face!==undefined){
   const face=object(m.face);keys(face,['gaze','blink']);if(!Object.keys(face).length||capabilities.facialAnimation!==true)throw Error('Invalid facial motion mapping');
   if(face.gaze!==undefined){const gaze=object(face.gaze);keys(gaze,['nodes','yawLimit','pitchLimit']);if(!Array.isArray(gaze.nodes)||!gaze.nodes.length||gaze.nodes.length>4||typeof gaze.yawLimit!=='number'||!Number.isFinite(gaze.yawLimit)||gaze.yawLimit<=0||gaze.yawLimit>.35||typeof gaze.pitchLimit!=='number'||!Number.isFinite(gaze.pitchLimit)||gaze.pitchLimit<=0||gaze.pitchLimit>.25)throw Error('Invalid gaze bounds');const names=new Set();for(const target of gaze.nodes){const node=object(target);keys(node,['node','yawAxis','pitchAxis']);if(!short(node.node)||names.has(node.node))throw Error('Invalid gaze target');names.add(node.node);for(const axis of [node.yawAxis,node.pitchAxis])if(!Array.isArray(axis)||axis.length!==3||axis.some(n=>typeof n!=='number'||!Number.isFinite(n))||Math.abs(Math.hypot(...axis)-1)>.001)throw Error('Invalid gaze axis');if(Math.abs((node.yawAxis as number[]).reduce((n,v,i)=>n+v*(node.pitchAxis as number[])[i]!,0))>.01)throw Error('Invalid gaze axes');}}
   if(face.blink!==undefined){const blink=object(face.blink);keys(blink,['clip','periodSeconds','durationSeconds']);if(!short(blink.clip)||typeof blink.periodSeconds!=='number'||!Number.isFinite(blink.periodSeconds)||blink.periodSeconds<1||blink.periodSeconds>30||typeof blink.durationSeconds!=='number'||!Number.isFinite(blink.durationSeconds)||blink.durationSeconds<.08||blink.durationSeconds>1||blink.durationSeconds>=blink.periodSeconds)throw Error('Invalid blink bounds');}
  }
  return structuredClone(m) as PresentationManifest;
}

/** Only allow curated data packages. No plugin code, URLs, source archives or browser filesystem paths. */
export class PresentationPackages {
  private packages = new Map<string, { manifest: PresentationManifest; digest: string; directory: string }>();
  readonly failures: string[] = [];
  private readonly options: { directory: string; ownerPrincipalId: string | (()=>string | undefined); catalogOnly?: boolean } | undefined;
  constructor(options?: { directory: string; ownerPrincipalId: string | (()=>string | undefined); catalogOnly?: boolean }) {
    this.options=options;
    if (!options) return;
    const root = realpathSync(options.directory), indexBytes = readFileSync(join(root,'index.json'));
    if (indexBytes.length > 8192) throw new Error('Presentation index is too large');
    const index: unknown = JSON.parse(indexBytes.toString());
    if (!Array.isArray(index) || index.length > 16 || index.some(id => typeof id !== 'string' || !identifier.test(id)) || new Set(index).size !== index.length) throw new Error('Invalid presentation index');
    for (const id of index) {
      try {
        const directory = this.contained(root, id), bytes = this.readBounded(this.contained(directory,'manifest.json'), 131072);
        const manifest = validatePresentation(JSON.parse(bytes.toString()));
        if (manifest.id !== id) throw new Error('Presentation identity mismatch');
        const entry = { manifest, digest: digest(bytes), directory }; this.packages.set(id,entry);
        // A remote catalog validates metadata only; endpoint hosts validate and serve bytes.
        if (options.catalogOnly === true) continue;
        for (const resource of manifest.resources) {
          const content = this.readBounded(this.contained(directory,resource.path),resource.bytes);
          if(content.length!==resource.bytes||digest(content)!==resource.sha256)throw new Error('Presentation resource changed');
          if (/\.(gltf|glb)$/u.test(resource.path)) this.validateModel(content, resource.path, manifest);
        }
      } catch { this.packages.delete(id); this.failures.push(id); }
    }
  }
  private contained(root: string, path: string): string {
    const resolved = realpathSync(join(root,path)), rel = relative(root,resolved);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Presentation path escaped its package');
    return resolved;
  }
  private readBounded(path: string, max: number): Buffer { if (!statSync(path).isFile() || statSync(path).size > max) throw new Error('Presentation file bound exceeded'); const bytes=readFileSync(path); if(bytes.length>max)throw new Error('Presentation file bound exceeded'); return bytes; }
  private validateModel(bytes: Buffer, path: string, manifest: PresentationManifest): void {
    let data: unknown;
    if (path.endsWith('.glb')) {
      if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a || bytes.readUInt32LE(12) > bytes.length-20) throw new Error('Invalid GLB');
      data=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
    } else data=JSON.parse(bytes.toString());
    const model=object(data);
    if (object(model.asset).version !== '2.0' || (Array.isArray(model.extensionsRequired) && model.extensionsRequired.some(name=>!['KHR_texture_transform','KHR_materials_clearcoat','KHR_materials_sheen','KHR_materials_specular','KHR_materials_ior','KHR_materials_transmission','KHR_materials_volume','KHR_materials_unlit'].includes(String(name))))) throw new Error('Unsupported model extension');
    const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')+1):'';
    const walk=(value: unknown, depth=0):void=>{
      if(depth>64)throw new Error('Model nesting bound exceeded');
      if(!value||typeof value!=='object')return;
      for(const [key,item] of Object.entries(value)) { if(key==='uri' && (typeof item!=='string' || !assetPath.test(item) || item.split('/').some(p=>p==='..'||p==='.'||!p) || !manifest.resources.some(r=>r.path===parent+item)))throw new Error('Undeclared model resource'); walk(item,depth+1); }
    }; walk(model);
  }
  private owner():string|undefined {const owner=this.options?.ownerPrincipalId;return typeof owner==='function'?owner():owner;}
  list(principalId: string): { id: string; label: string; digest: string; manifest: PresentationManifest }[] {
    if(principalId!==this.owner())return [];
    return [...this.packages].map(([id,e])=>({id,label:e.manifest.label,digest:e.digest,manifest:structuredClone(e.manifest)}));
  }
  matches(principalId: string, id: string, digest: string): boolean { return principalId===this.owner() && this.packages.get(id)?.digest===digest; }
  resource(principalId: string, id: string, path: string): { bytes: Buffer; mime: string } {
    if(this.options?.catalogOnly === true)throw new Error('Presentation resource unavailable');
    const entry=principalId===this.owner()?this.packages.get(id):undefined, resource=entry?.manifest.resources.find(r=>r.path===path);
    if(!entry||!resource)throw new Error('Presentation resource unavailable');
    const bytes=this.readBounded(this.contained(entry.directory,path),resource.bytes);
    if(bytes.length!==resource.bytes||digest(bytes)!==resource.sha256)throw new Error('Presentation resource changed');
    return {bytes,mime:resource.mime};
  }
}

export class PresentationSelection {
  private readonly database: Database;
  constructor(database: Database) {this.database=database;}
  read(principalId: string, endpointId: string, sessionId: string) {
    const rows=this.database.connection.prepare('SELECT scope_id AS scope, package_id AS id, package_digest AS digest, revision FROM presentation_selections WHERE principal_id=? AND endpoint_id=? AND scope_id IN (?,?)').all(principalId,endpointId,'default',sessionId) as {scope:string;id:string;digest:string;revision:number}[];
    const override=rows.find(r=>r.scope===sessionId);
    return {default:rows.find(r=>r.scope==='default')??null,override:override?.id==='@inherit'?null:override??null,overrideRevision:override?.revision??0};
  }
  runtimeState(principalId:string,endpointId:string|null,sessionId:string,catalog:PresentationPackages,permitted:boolean):{state:'notConfigured'|'configuredNotObserved'|'unavailable';revision:string} {
    if(!permitted)return {state:'unavailable',revision:'audience-restricted'};
    if(!endpointId)return {state:'notConfigured',revision:'unbound'};
    const selection=this.read(principalId,endpointId,sessionId),chosen=selection.override??selection.default;
    if(!chosen)return {state:'notConfigured',revision:'no-saved-selection'};
    const available=chosen.id==='neutral'?chosen.digest==='neutral-v1':catalog.matches(principalId,chosen.id,chosen.digest);
    // Only an opaque revision crosses into cognition. Asset names, paths and mappings stay endpoint-local.
    return {state:available?'configuredNotObserved':'unavailable',revision:createHash('sha256').update(JSON.stringify([selection.override?'session':'default',chosen.id,chosen.digest,chosen.revision])).digest('hex')};
  }
  select(principalId:string,endpointId:string,sessionId:string,input:Record<string,unknown>,catalog:PresentationPackages) {
    const clear=input.operation==='clearSessionOverride';
    keys(input,clear?['operation','expectedRevision']:['scope','id','digest','expectedRevision']);
    if((!clear&&!['default','session'].includes(String(input.scope)))||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)throw new Error('Invalid presentation selection');
    // A reserved non-package identity retains the revision after clearing, preventing ABA writes.
    const selection=clear?{id:'@inherit',digest:'inherit-v1'}:input.id==='neutral'?{id:'neutral',digest:'neutral-v1'}:catalog.list(principalId).find(p=>p.id===input.id&&p.digest===input.digest);
    if(!selection||!clear&&input.digest!==selection.digest)throw new Error('Presentation selection unavailable');
    const scope=!clear&&input.scope==='default'?'default':sessionId;
    this.database.transaction(tx=>{
      const current=tx.get<{revision:number}>('SELECT revision FROM presentation_selections WHERE principal_id=? AND endpoint_id=? AND scope_id=?',principalId,endpointId,scope);
      if((current?.revision??0)!==input.expectedRevision)throw new Error('Presentation revision conflict');
      tx.run('INSERT INTO presentation_selections VALUES (?,?,?,?,?,?) ON CONFLICT(principal_id,endpoint_id,scope_id) DO UPDATE SET package_id=excluded.package_id,package_digest=excluded.package_digest,revision=excluded.revision',principalId,endpointId,scope,selection.id,selection.digest,Number(input.expectedRevision)+1);
    });
    return this.read(principalId,endpointId,sessionId);
  }
}
