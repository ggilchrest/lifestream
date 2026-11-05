// Closed data only. Executable adapters are configured by the host, never here.
export type WorldDeltaFields={sourceVariant:{packageId:string;variantId:string;catalogId:string;modelSha256:string};worldDelta:{adapter:'world-delta.v1';family:string;rotationY:number;basis:number[];boneMap:Record<string,string>;referenceResource:string;animations:{sourceAnimationId:string;clipName:string;resource:string;playback:'finite-once-clamp'}[];families:{id:string;members:string[]}[];cycle:string[];transitionSeconds:number};physics:{profileResource:string;profileSha256:string;sourceVariantId:string;modelSha256:string}};
export type SecondaryPhysicsProfile={id:string;hairBones:string[];softBones:string[];colliders:{bone:string;a:number[];b:number[];radius:number}[];limits:string[];derivation:{headNeckDistance:number;shoulderWidth:number;weightedJointsAndAncestors:number}};
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid presentation adapter data');return v as Record<string,unknown>;};
const keys=(v:Record<string,unknown>,allowed:string[])=>{if(Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Unsupported presentation adapter field');};
const text=(v:unknown,max=128):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f<>]/u.test(v)&&!['__proto__','prototype','constructor'].includes(v);
const token=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const finite=(v:unknown,max=1e6):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=max;
const vector=(v:unknown,n:number)=>Array.isArray(v)&&v.length===n&&v.every(x=>finite(x));
export function validatePhysicsProfile(value:unknown):SecondaryPhysicsProfile{
 const p=record(value);keys(p,['id','hairBones','softBones','colliders','limits','derivation']);if(!text(p.id))throw Error('Invalid physics profile identity');
 const names=new Set<string>();for(const [field,cap]of [['hairBones',256],['softBones',32]] as const){const list=p[field];if(!Array.isArray(list)||list.length<1||list.length>cap||list.some(n=>!text(n)||names.has(n)||!names.add(n)))throw Error('Invalid physics bone declaration');}
 if(!Array.isArray(p.colliders)||p.colliders.length<1||p.colliders.length>64)throw Error('Invalid physics collider bound');const colliderNames=new Set();
 for(const value of p.colliders){const c=record(value);keys(c,['bone','a','b','radius']);if(!text(c.bone)||colliderNames.has(c.bone)||!vector(c.a,3)||!vector(c.b,3)||!finite(c.radius,10)||c.radius<=0)throw Error('Invalid physics collider');colliderNames.add(c.bone);}
 if(!Array.isArray(p.limits)||p.limits.length>16||p.limits.some(v=>!text(v,512)))throw Error('Invalid physics limitation');
 const d=record(p.derivation);keys(d,['headNeckDistance','shoulderWidth','weightedJointsAndAncestors']);if(!finite(d.headNeckDistance,10)||d.headNeckDistance<=0||!finite(d.shoulderWidth,10)||d.shoulderWidth<=0||!Number.isSafeInteger(d.weightedJointsAndAncestors)||Number(d.weightedJointsAndAncestors)<1||Number(d.weightedJointsAndAncestors)>2048)throw Error('Invalid physics derivation');
 return value as SecondaryPhysicsProfile;
}
export function validateWorldDeltaFields(m:Record<string,unknown>):WorldDeltaFields{
 const source=record(m.sourceVariant);keys(source,['packageId','variantId','catalogId','modelSha256']);if(!token(source.packageId)||!token(source.variantId)||source.variantId!==m.id||source.catalogId!==`mod:${source.packageId}:${source.variantId}`||!digest(source.modelSha256))throw Error('Invalid explicit source variant');
 const resources=m.resources as {path:string;sha256:string;bytes:number;mime:string}[];const model=resources.find(r=>r.path===m.model);if(model?.sha256!==source.modelSha256)throw Error('Source model digest mismatch');
 const glb=(p:unknown)=>typeof p==='string'&&resources.some(r=>r.path===p&&r.mime==='model/gltf-binary'&&p.endsWith('.glb'));
 const w=record(m.worldDelta);keys(w,['adapter','family','rotationY','basis','boneMap','referenceResource','animations','families','cycle','transitionSeconds']);
 if(w.adapter!=='world-delta.v1'||!text(w.family,64)||!finite(w.rotationY,Math.PI)||!vector(w.basis,16)||!glb(w.referenceResource)||w.referenceResource===m.model||!finite(w.transitionSeconds,1)||w.transitionSeconds<0)throw Error('Invalid world-delta recipe');
 const b=w.basis as number[];const determinant=b[0]!*(b[5]!*b[10]!-b[9]!*b[6]!)-b[4]!*(b[1]!*b[10]!-b[9]!*b[2]!)+b[8]!*(b[1]!*b[6]!-b[5]!*b[2]!);
 if(b[3]!==0||b[7]!==0||b[11]!==0||b[15]!==1||!Number.isFinite(determinant)||Math.abs(determinant)<1e-8)throw Error('Invalid world-delta basis');
 const map=record(w.boneMap),pairs=Object.entries(map);if(pairs.length<1||pairs.length>1024||pairs.some(([a,b])=>!text(a)||!text(b))||new Set(Object.values(map)).size!==pairs.length)throw Error('Invalid explicit bone map');
 if(!Array.isArray(w.animations)||!w.animations.length||w.animations.length>128)throw Error('Invalid external animation bound');const ids=new Set<string>(),clips=new Set<string>();
 for(const value of w.animations){const a=record(value);keys(a,['sourceAnimationId','clipName','resource','playback']);if(!text(a.sourceAnimationId)||!text(a.clipName)||!glb(a.resource)||a.playback!=='finite-once-clamp'||ids.has(a.sourceAnimationId)||clips.has(a.clipName))throw Error('Invalid exact source animation');ids.add(a.sourceAnimationId);clips.add(a.clipName);}
 if(!Array.isArray(w.families)||!w.families.length||w.families.length>32)throw Error('Invalid animation families');const members:string[]=[],familyIds=new Set();
 for(const value of w.families){const f=record(value);keys(f,['id','members']);if(!text(f.id)||familyIds.has(f.id)||!Array.isArray(f.members)||!f.members.length||f.members.some(id=>!ids.has(id)))throw Error('Invalid family members');familyIds.add(f.id);members.push(...f.members);}
 if(members.length!==ids.size||new Set(members).size!==ids.size||!Array.isArray(w.cycle)||w.cycle.length!==ids.size||new Set(w.cycle).size!==ids.size||w.cycle.some(id=>!ids.has(id)))throw Error('Missing or repeated animation member');
 const physics=record(m.physics);keys(physics,['profileResource','profileSha256','sourceVariantId','modelSha256']);const profile=resources.find(r=>r.path===physics.profileResource);
 if(resources.filter(r=>r.mime==='application/json').length!==1||!profile||!profile.path.endsWith('.json')||profile.mime!=='application/json'||profile.bytes>65536||!digest(physics.profileSha256)||profile.sha256!==physics.profileSha256||physics.sourceVariantId!==source.catalogId||physics.modelSha256!==source.modelSha256)throw Error('Invalid explicit physics binding');
 return {sourceVariant:source,worldDelta:w,physics} as unknown as WorldDeltaFields;
}
