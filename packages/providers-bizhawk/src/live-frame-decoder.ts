import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {inspectGamePng} from './frame-custody.ts';
import type {ActivityScope,GameObservation,PlayerVisibleStateValue} from '@lifestream/contracts/game-activity';

export type PixelRegion={x:number;y:number;width:number;height:number;rgbSha256:string};
export type ReviewedPixelCue={regions:readonly PixelRegion[];fieldId:string;value:string|number|boolean};
export type LiveFrameManifest={revision:string;cues:readonly ReviewedPixelCue[]};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
/** Bounded actual PNG pixels. CRC/structure/decompression are checked before
 * unfiltering. Return an owned RGB buffer; callers must erase it after use. */
export function gameFramePixels(bytes:Buffer):{width:number;height:number;rgb:Buffer}{
 const size=inspectGamePng(bytes,1024),channels=bytes[25]===2?3:4,stride=size.width*channels,data:Buffer[]=[];
 for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='IDAT')data.push(bytes.subarray(at+8,at+8+length));at+=length+12;}
 const inflated=inflateSync(Buffer.concat(data),{maxOutputLength:(stride+1)*size.height}),decoded=Buffer.alloc(stride*size.height),rgb=Buffer.alloc(size.width*size.height*3);
 try{
  for(let y=0;y<size.height;y++)for(let x=0;x<stride;x++){
   const filter=inflated[y*(stride+1)]!,raw=inflated[y*(stride+1)+x+1]!,a=x>=channels?decoded[y*stride+x-channels]!:0,b=y?decoded[(y-1)*stride+x]!:0,c=y&&x>=channels?decoded[(y-1)*stride+x-channels]!:0;
   decoded[y*stride+x]=(raw+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;
  }
  for(let i=0;i<size.width*size.height;i++){if(channels===4&&decoded[i*4+3]!==255)throw Error('opaque_game_pixels_required');decoded.copy(rgb,i*3,i*channels,i*channels+3);}
  return {...size,rgb};
 }catch(error){rgb.fill(0);throw error;}finally{inflated.fill(0);decoded.fill(0);}
}
export function gamePixelRegionDigest(rgb:Buffer,width:number,height:number,region:Omit<PixelRegion,'rgbSha256'>):string{
 if(![width,height,region.x,region.y,region.width,region.height].every(Number.isSafeInteger)||region.x<0||region.y<0||region.width<1||region.height<1||region.x+region.width>width||region.y+region.height>height||rgb.length!==width*height*3)throw Error('game_pixel_region_unavailable');
 const digest=createHash('sha256');for(let y=region.y;y<region.y+region.height;y++)digest.update(rgb.subarray((y*width+region.x)*3,(y*width+region.x+region.width)*3));return digest.digest('hex');
}
/** Deterministic visible-pixel measurements on EVERY current qualified PNG,
 * plus positive literal UI cues from reviewed exact pixel regions. Changing
 * unrelated pixels does not hide a matched cue. An absent/changed cue supplies
 * no field, never a claimed absence, safe menu, inferred location or game stat. */
export class LiveFrameDecoder{
 readonly revision:string;readonly manifestDigest:string;private readonly cues:readonly ReviewedPixelCue[];
 constructor(manifest:LiveFrameManifest){
  if(!manifest||!/^\d+\.\d+\.\d+$/.test(manifest.revision)||!Array.isArray(manifest.cues)||manifest.cues.length>62)throw Error('live_frame_manifest_unavailable');
  const fields=new Set<string>();for(const cue of manifest.cues){
   if(!/^ct\.ui\.[A-Za-z0-9_.-]{1,100}$/.test(cue.fieldId)||fields.has(cue.fieldId)||!['string','number','boolean'].includes(typeof cue.value)||typeof cue.value==='number'&&!Number.isFinite(cue.value)||typeof cue.value==='string'&&cue.value.length>500||!Array.isArray(cue.regions)||cue.regions.length<1||cue.regions.length>8)throw Error('live_frame_manifest_unavailable');fields.add(cue.fieldId);
   for(const r of cue.regions)if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>1024||r.y+r.height>1024||!/^[a-f0-9]{64}$/.test(r.rgbSha256))throw Error('live_frame_manifest_unavailable');
  }
  const snapshot=JSON.stringify(manifest);this.manifestDigest=hash(Buffer.from(snapshot));this.revision=manifest.revision;this.cues=JSON.parse(snapshot).cues;
  for(const cue of this.cues){for(const r of cue.regions)Object.freeze(r);Object.freeze(cue.regions);Object.freeze(cue);}Object.freeze(this.cues);Object.freeze(this);
 }
 decode({scope,observation,bytes,now}:{scope:ActivityScope;observation:GameObservation;bytes:Buffer;now:number}):PlayerVisibleStateValue[]{
  const shot=observation.screenshots[0];if(!Number.isFinite(now)||!isDeepStrictEqual(scope,observation.scope)||observation.untrusted!==true||observation.screenshots.length!==1||!shot||bytes.length>2097152||shot.sha256!==hash(bytes)||shot.byteLength!==bytes.length||shot.mediaType!=='image/png'||shot.frameNumber!==observation.frameNumber||shot.capturedAt!==observation.capturedAt)return [];
  const captured=Date.parse(shot.capturedAt),expires=Date.parse(shot.expiresAt);if(!Number.isFinite(captured)||!Number.isFinite(expires)||captured>now||expires<=now||expires-captured>30000)return [];
  let image:ReturnType<typeof gameFramePixels>;try{image=gameFramePixels(bytes);}catch{return [];}try{
   if(image.width!==shot.width||image.height!==shot.height)return [];
   const values:Array<{fieldId:string;value:string|number|boolean}>=[];
   values.push({fieldId:'display.visible.isEntirelyBlack',value:image.rgb.every(v=>v===0)});
   values.push({fieldId:'display.visible.rgbSha256',value:hash(image.rgb)});
   for(const cue of this.cues){let matched=false;try{matched=cue.regions.every(r=>gamePixelRegionDigest(image.rgb,image.width,image.height,r)===r.rgbSha256);}catch{}if(matched)values.push({fieldId:cue.fieldId,value:cue.value});}
   return values.map(value=>({...value,visibility:'visibleNow',firstObservedRef:observation.observationId,lastObservedRef:observation.observationId,timelineId:scope.timelineId,observedAt:shot.capturedAt,freshUntil:shot.expiresAt,decoderRevision:this.revision,manifestDigest:this.manifestDigest,limitations:['Actual visible PNG pixels only; no hidden RAM, inferred gameplay state or model-supplied field values.','UI cues are positive exact reviewed pixel matches; a missing match does not prove absence or menu safety.','No controller, ordinary save/load, memory or image-disclosure authority is supplied.']}));
  }finally{image.rgb.fill(0);}
 }
}
