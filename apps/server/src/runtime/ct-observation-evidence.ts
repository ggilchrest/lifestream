import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {inspectGamePng} from '@lifestream/providers-bizhawk';
import type {ActivityScope,GameObservation,GameScreenshot} from '@lifestream/contracts/game-activity';

/** The original native owner supplies the held frame; this validates its join
 * and emits only game image metadata. It grants no scene or input authority. */
export function captureCtObservationEvidence(scope:ActivityScope,observation:GameObservation,frame:{observation:GameObservation;screenshot:GameScreenshot;bytes:Uint8Array},qualificationRef:string|null,annotationOrigin:'AGENT'|'HUMAN'|'UNSPECIFIED'='UNSPECIFIED'){
 const shot=observation.screenshots[0];
 if(!['AGENT','HUMAN','UNSPECIFIED'].includes(annotationOrigin))throw Error('ct_annotation_origin_required');
 if(!shot||observation.screenshots.length!==1||!isDeepStrictEqual(scope,observation.scope)||!isDeepStrictEqual(scope,frame.observation.scope)||frame.observation.observationId!==observation.observationId||frame.observation.frameNumber!==observation.frameNumber||!isDeepStrictEqual(shot,frame.screenshot)||frame.bytes.byteLength!==shot.byteLength||shot.byteLength>2097152||shot.mediaType!=='image/png'||shot.sha256!==createHash('sha256').update(frame.bytes).digest('hex')||shot.frameNumber!==observation.frameNumber||shot.capturedAt!==observation.capturedAt||!Number.isFinite(Date.parse(shot.capturedAt))||Date.parse(shot.capturedAt)>Date.now()||!Number.isFinite(Date.parse(shot.expiresAt))||Date.parse(shot.expiresAt)<=Date.now()||qualificationRef!==null&&(typeof qualificationRef!=='string'||qualificationRef.length<1||qualificationRef.length>500))throw Error('ct_actual_frame_join_required');
 const png=inspectGamePng(Buffer.from(frame.bytes),1024);
 if(png.width!==shot.width||png.height!==shot.height)throw Error('ct_actual_frame_dimensions_required');
 const allowed=new Set(['ct.ui.controller-domain','ct.ui.scene','ct.ui.dialogue.text','ct.ui.dialogue.present','ct.ui.player.x','ct.ui.player.y']);
 if(observation.visibleState.some(f=>f.fieldId==='ct.ui.dialogue.present'&&typeof f.value!=='boolean'))throw Error('ct_dialogue_boolean_required');
 const fields=observation.visibleState.filter(f=>allowed.has(f.fieldId)&&f.visibility==='visibleNow'&&f.lastObservedRef===observation.observationId&&f.timelineId===scope.timelineId&&Date.parse(f.freshUntil)>Date.now()).map(f=>Object.freeze({fieldId:f.fieldId,value:f.value,manifestDigest:f.manifestDigest,decoderRevision:f.decoderRevision,sourceObservationId:f.lastObservedRef}));
 return Object.freeze({schemaVersion:'ct-actual-game-image/1',scopeDigest:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),observationId:observation.observationId,observationRevision:observation.revision,frameNumber:observation.frameNumber,capturedAt:observation.capturedAt,receivedAt:observation.receivedAt,previousActionId:observation.previousActionId,screenshot:Object.freeze({screenshotId:shot.screenshotId,sha256:shot.sha256,byteLength:shot.byteLength,width:shot.width,height:shot.height,mediaType:shot.mediaType}),interpretation:Object.freeze({matchedReviewedScene:fields.some(f=>f.fieldId==='ct.ui.controller-domain'&&f.value==='ordinaryGameplay'),pixelFacts:'AUTOMATIC: native PNG bytes, dimensions, digest, frame and observation identities',sceneSemantics:qualificationRef?(annotationOrigin==='UNSPECIFIED'?'UNSPECIFIED: reference-image annotation authorship; AUTOMATIC: exact reviewed-image matching':annotationOrigin+': reference-image annotations; AUTOMATIC: exact reviewed-image matching'):'No reviewed scene semantics asserted',annotationOrigin,qualificationRef,fields:Object.freeze(fields)}),controllerAuthority:false});
}
export type CtObservationEvidence=ReturnType<typeof captureCtObservationEvidence>;
