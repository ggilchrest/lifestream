import {ReviewedFrameDecoder,type ReviewedFrameManifest} from '@lifestream/providers-bizhawk';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';

export type ReviewedDialogueProfile=Readonly<{
 schemaVersion:'reviewed-dialogue-profile/1';qualificationRef:string;annotationOrigin:'AGENT'|'HUMAN';
 manifest:ReviewedFrameManifest;
}>;
/** Exact independently reviewed image annotations supply one visual primitive.
 * This table supplies no scene/text/identity, menu safety or input authority.
 * A missing image match is unknown, never a negative dialogue observation. */
export function captureReviewedDialogueProfile(raw:unknown){
 const value=boundedGameDataSnapshot(raw,8192) as ReviewedDialogueProfile|null;
 function fail():never{throw Error('Reviewed dialogue profile unavailable');}
 if(!value||Object.keys(value).sort().join(',')!=='annotationOrigin,manifest,qualificationRef,schemaVersion'||value.schemaVersion!=='reviewed-dialogue-profile/1'||!['AGENT','HUMAN'].includes(value.annotationOrigin)||typeof value.qualificationRef!=='string'||!value.qualificationRef.trim()||value.qualificationRef.length>500)fail();
 const manifest=value.manifest;
 if(!manifest||Object.keys(manifest).sort().join(',')!=='digestMode,entries,revision'||manifest.digestMode!=='pngBytes'||!Array.isArray(manifest.entries)||manifest.entries.length!==2)fail();
 const values=new Set<boolean>();
 for(const entry of manifest.entries){
  if(!entry||Object.keys(entry).sort().join(',')!=='fields,height,sha256,width'||!Array.isArray(entry.fields)||entry.fields.length!==1)fail();
  const field=entry.fields[0]!;
  if(!field||Object.keys(field).sort().join(',')!=='fieldId,value'||field.fieldId!=='ct.ui.dialogue.present'||typeof field.value!=='boolean')fail();
  values.add(field.value);
 }
 if(values.size!==2)fail();
 const decoder=new ReviewedFrameDecoder(manifest),profile=freeze(value);
 return Object.freeze({profile,decoder,descriptor:freeze({qualificationRef:profile.qualificationRef,annotationOrigin:profile.annotationOrigin,manifestDigest:decoder.manifestDigest})});
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
