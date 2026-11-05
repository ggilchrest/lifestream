import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {gameFramePixels} from '@lifestream/providers-bizhawk';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const time=value=>{const n=Date.parse(value);assert.ok(Number.isFinite(n));return n;};
const buttons=['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'];
/** Diagnostic consistency only. Caller supplies bytes/receipts from its existing
 * owned native evidence/custody lane; this module captures nothing and never
 * creates source authenticity, scene fields, Pause causality or input authority.
 * Three samples can establish sampled stability, not absence of intervening input. */
export function inspectNativeCaptureSeries(samples,{scope,pinsDigest,providerRef,romSha1,current}){
 assert.equal(typeof current,'function','Existing current owned evidence lane required');assert.equal(current(),true);
 assert.ok(Array.isArray(samples)&&samples.length===3&&/^[a-f0-9]{64}$/.test(pinsDigest));
 let bytesHeld=0,sequence=-1,mono=-1;const rows=[];
 for(const {observation:o,nativeSnapshot:n,png} of samples){
  assert.ok(isDeepStrictEqual(o?.scope,scope)&&isDeepStrictEqual(n?.scope,scope));
  assert.ok(o.schemaVersion==='1.0.0'&&o.recordType==='gameObservation'&&o.untrusted===true&&o.pinsDigest===pinsDigest&&o.screenshots?.length===1);
  assert.ok(n.schemaVersion==='1.0.0'&&n.recordType==='nativeGameEvidence'&&n.event==='observation'&&n.pinsDigest===pinsDigest&&n.providerRef===providerRef&&n.romSha1===romSha1&&n.system==='SNES'&&n.version==='2.11.1');
  assert.ok(Number.isSafeInteger(n.sequence)&&n.sequence>sequence&&Number.isFinite(n.monotonicMs)&&n.monotonicMs>mono&&Number.isSafeInteger(o.frameNumber)&&o.frameNumber>=0&&n.frameNumber===o.frameNumber);
  assert.ok(n.lastObservation?.outcome?.status==='succeeded'&&isDeepStrictEqual(n.lastObservation.outcome.payload?.observation,o),'Retained original observation receipt required');
  assert.ok(typeof n.paused==='boolean'&&n.buttonsAvailable===true&&buttons.every(b=>typeof n.buttons?.[b]==='boolean'));
  assert.ok(png instanceof Uint8Array&&png.byteLength>=57&&png.byteLength<=2097152);bytesHeld+=png.byteLength;assert.ok(bytesHeld<=6291456);
  const shot=o.screenshots[0],b=Buffer.from(png.buffer,png.byteOffset,png.byteLength);
  assert.ok(shot.mediaType==='image/png'&&shot.sha256===hash(b)&&shot.byteLength===b.length&&shot.frameNumber===o.frameNumber&&shot.capturedAt===o.capturedAt);
  const captured=time(o.capturedAt),received=time(o.receivedAt),checked=time(n.checkedAt),expires=time(shot.expiresAt);
  assert.ok(captured<=received&&received<=checked&&checked-captured<=5000&&expires>captured&&expires-captured<=30000);
  const image=gameFramePixels(b);
  try{assert.equal(image.width,shot.width);assert.equal(image.height,shot.height);rows.push({frameNumber:o.frameNumber,observationId:o.observationId,sequence:n.sequence,monotonicMs:n.monotonicMs,paused:n.paused,neutral:buttons.every(button=>n.buttons[button]===false),pngSha256:shot.sha256,rgbSha256:hash(image.rgb),width:image.width,height:image.height,entirelyBlack:image.rgb.every(v=>v===0)});}finally{image.rgb.fill(0);}
  sequence=n.sequence;mono=n.monotonicMs;
 }
 assert.ok(rows[2].monotonicMs-rows[1].monotonicMs>=5000,'Five seconds after the second sample required');
 assert.equal(current(),true,'Owned evidence lane changed while checking');
 const sameFrame=rows.every(row=>row.frameNumber===rows[0].frameNumber),samePixels=rows.every(row=>row.width===rows[0].width&&row.height===rows[0].height&&row.rgbSha256===rows[0].rgbSha256);
 return Object.freeze({kind:'capture-series-consistency-only',samples:Object.freeze(rows.map(Object.freeze)),elapsedAfterSecondSampleMs:rows[2].monotonicMs-rows[1].monotonicMs,sameFrame,samePixels,allPaused:rows.every(row=>row.paused),allSampledControlsNeutral:rows.every(row=>row.neutral),sampledPausedStability:sameFrame&&samePixels&&rows.every(row=>row.paused&&row.neutral),sourceAuthenticityProven:false,causalPauseProven:false,immediatePauseTimingProven:false,ordinaryGameplayQualified:false,inputAuthoritySupplied:false,limitations:Object.freeze(['Original current source custody and authenticity remain with the existing native owner, not these supplied records.','No Pause event was supplied, so the second sample is not proven immediate relative to Pause.','Sampled stability does not prove no intervening inputs or manual frame advancement.','No scene/dialogue/player facts, controller permission or live gameplay qualification are produced.'])});
}
