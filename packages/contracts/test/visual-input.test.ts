import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createContractValidator} from '../src/validator.ts';
import {validateVisualInput,visualInputSchemaId,visualInputWireProfile,visualInputSchemaVersion,type VisualInputKind,type VisualCameraRequest,type VisualCapabilitiesResponse,type VisualBatchResponse} from '../src/visual-input.ts';

const assistantId=randomUUID(),leaseId=randomUUID(),mappingId=randomUUID(),frameId=randomUUID(),requestId=randomUUID();
const base={schemaVersion:visualInputSchemaVersion,assistantId};
const responseBase={schemaVersion:visualInputSchemaVersion,wireProfile:visualInputWireProfile};
const echo={challengeId:randomUUID(),endpointClockId:'synthetic-clock:1',endpointReceivedMonotonicMs:42.25};
const command={...base,expectedRevision:0,idempotencyKey:randomUUID()};
const disabled={revision:0,captureActive:false,activeForSession:false,reason:'disabled' as const,leaseId:null,expiresAtMonotonicMs:null,clockMappingId:null,currentObservationUsable:false};
const active={revision:1,captureActive:true,activeForSession:false,reason:'frame_stale' as const,leaseId,expiresAtMonotonicMs:60_020,clockMappingId:mappingId,currentObservationUsable:false};
const negotiation={profile:'lifestream.conversational-vision.v1' as const,selectedVersion:visualInputSchemaVersion,implemented:true as const,configured:true,providerConnected:true,sourceConnected:true,mediaTypes:['image/png' as const],bounds:{maxFramesPerBatch:3,maxCaptureFramesPerSecond:3,maxBatchSpanMs:2000,maxFrameBytes:1048576,maxLongEdgePixels:1280,minAdmissionIntervalMs:1000,maxRawBytesPerSession:12582912,maxDecodedBytesPerSession:20971520,maxHostSessions:4,leaseTtlMs:60000,renewIntervalMs:20000,deadlineMs:3000,freshnessMs:6000,maxClockUncertaintyMs:250},challenge:{id:randomUUID(),hostSentMonotonicMs:0,hostSentAt:'2026-09-29T00:00:00.000Z',expiresAt:'2026-09-29T00:00:05.000Z'}};
const capabilities:VisualCapabilitiesResponse={...responseBase,available:true,reason:null,negotiation,transport:{maxConcurrentUploadsPerSession:1,maxConcurrentUploadsPerHost:4,uploadDeadlineMs:5000},camera:disabled};
const frame={frameId,sequence:0,capturedMonotonicMs:50.5,clockMappingId:mappingId,mediaType:'image/png',sha256:'a'.repeat(64)};
const batch={...base,leaseId,endpointClockId:'synthetic-clock:1',correlationId:randomUUID(),frames:[frame]};
const receipt:VisualBatchResponse={...responseBase,requestId,queued:false,result:{requestId,status:'complete',observations:[{observationId:'synthetic-observation',frameIds:[frameId],appearance:'A square.',inference:null,confidence:null,limitations:['Scripted fixture only.']}],reason:null}};
const assertValid=(kind:VisualInputKind,value:unknown)=>assert.deepEqual(validateVisualInput(kind,value),{valid:true,errors:[]});
const assertInvalid=(kind:VisualInputKind,value:unknown)=>assert.equal(validateVisualInput(kind,value).valid,false);

test('independent visual HTTP adapter declares its identity and compiles without canonical-envelope aliasing',()=>{
  const validator=createContractValidator();
  assert.ok(validator.schemaIds().includes(visualInputSchemaId));
  assert.notEqual(visualInputSchemaId,'https://lifestream.dev/contracts/conversational-vision/1.0.0');
  assertValid('capabilitiesRequest',{...base,supportedVersions:['1.0.0','0.9.0']});
  assertValid('capabilitiesResponse',capabilities);
  assertValid('capabilitiesResponse',{...responseBase,available:false,reason:'source_unavailable',negotiation:null,camera:disabled});
  assertValid('capabilitiesResponse',{...capabilities,available:false,reason:'unsupported',negotiation:{...negotiation,profile:null,selectedVersion:null,challenge:null}});
  assertValid('cameraResponse',{...responseBase,camera:active});
  assertValid('batchRequest',batch);
  assertValid('batchResponse',receipt);
  assertValid('errorResponse',{code:'frame_oversize'});
  assertValid('errorResponse',{code:'authentication_required',message:'Authentication required.'});
  assertInvalid('capabilitiesResponse',{...capabilities,wireProfile:'lifestream.conversational-vision.v1'});
  const {wireProfile:_profile,...missing}=capabilities;assertInvalid('capabilitiesResponse',missing);
  assertInvalid('capabilitiesResponse',{...capabilities,schemaVersion:'2.0.0'});
});

test('camera variants bind enable, renewal and stop without accepting authority or stale clock fields',()=>{
  const enable:VisualCameraRequest={...command,action:'enable',...echo};
  const renew:VisualCameraRequest={...command,action:'renew',leaseId,...echo};
  const stop:VisualCameraRequest={...command,action:'stop',leaseId};
  for(const value of [enable,renew,stop])assertValid('cameraRequest',value);
  for(const value of [{...enable,leaseId},{...renew,leaseId:undefined},{...stop,challengeId:echo.challengeId},{...stop,endpointReceivedMonotonicMs:0},{...enable,expectedRevision:0.5},{...enable,expectedRevision:Number.MAX_SAFE_INTEGER+1},{...enable,endpointReceivedMonotonicMs:Infinity},{...enable,action:'restore'},{...enable,idempotencyKey:'invalid'},{...enable,schemaVersion:'2.0.0'},{...enable,sourceBindingRef:'forged'}])assertInvalid('cameraRequest',value);
});

test('request validation rejects forged scope, inline media, unknown fields and structurally over-bound input',()=>{
  for(const extra of [{principalId:randomUUID()},{scope:{authority:true}},{sourceBindingRef:'camera'},{permission:true},{bytes:'hidden-bytes'},{base64:'hidden-bytes'},{url:'https://invalid.example/hidden-bytes'}]){
    assertInvalid('capabilitiesRequest',{...base,supportedVersions:['1.0.0'],...extra});
    assertInvalid('batchRequest',{...batch,...extra});
  }
  for(const supportedVersions of [[],['1.0.0','1.0.0'],['1.0.0-beta'],['1.0.0','2.0.0','3.0.0','4.0.0','5.0.0']])assertInvalid('capabilitiesRequest',{...base,supportedVersions});
  for(const frames of [[],[frame,frame],Array.from({length:4},(_,sequence)=>({...frame,frameId:randomUUID(),sequence})),[{...frame,bytes:[1,2,3]}],[{...frame,sha256:'A'.repeat(64)}],[{...frame,sequence:-1}],[{...frame,capturedMonotonicMs:NaN}],[{...frame,mediaType:'image/webp'}]])assertInvalid('batchRequest',{...batch,frames});
});

test('success responses cannot claim contradictory active state or loosen reference maxima',()=>{
  for(const camera of [{...disabled,captureActive:true},{...disabled,currentObservationUsable:true},{...active,activeForSession:true},{...active,leaseId:null},{...active,clockMappingId:'wrong'}])assertInvalid('cameraResponse',{...responseBase,camera});
  assertValid('cameraResponse',{...responseBase,camera:{...active,activeForSession:true,currentObservationUsable:true,reason:null}});
  for(const bounds of [{...negotiation.bounds,maxFramesPerBatch:4},{...negotiation.bounds,maxFrameBytes:2097153},{...negotiation.bounds,minAdmissionIntervalMs:999},{...negotiation.bounds,leaseTtlMs:60001}])assertInvalid('capabilitiesResponse',{...capabilities,negotiation:{...negotiation,bounds}});
  assertValid('capabilitiesResponse',{...capabilities,negotiation:{...negotiation,bounds:{...negotiation.bounds,minAdmissionIntervalMs:2000}}});
  for(const patch of [{negotiation:null},{reason:'unsupported'},{negotiation:{...negotiation,providerConnected:false}},{negotiation:{...negotiation,selectedVersion:null}},{transport:{maxConcurrentUploadsPerSession:2,maxConcurrentUploadsPerHost:4,uploadDeadlineMs:5000}}])assertInvalid('capabilitiesResponse',{...capabilities,...patch});
});

test('perception receipts are closed and failure outcomes cannot carry observations',()=>{
  for(const status of ['empty','rejected','cancelled','timedOut','failed'])assertValid('batchResponse',{...receipt,result:{requestId,status,observations:[],reason:'synthetic_outcome'}});
  for(const result of [{...receipt.result,status:'heard'},{...receipt.result,status:'failed'},{...receipt.result,authority:true},{...receipt.result,reason:'x'.repeat(129)},{...receipt.result,observations:Array.from({length:33},()=>receipt.result.observations[0])},{...receipt.result,observations:[{...receipt.result.observations[0],confidence:1.01}]},{...receipt.result,observations:[{...receipt.result.observations[0],toolCall:{name:'dispatch'}}]}])assertInvalid('batchResponse',{...receipt,result});
});

test('validation returns redacted independent errors and never mutates caller objects',()=>{
  const value={...batch,privatePayload:'SYNTHETIC_PRIVATE_VALUE'},saved=structuredClone(value);
  const result=validateVisualInput('batchRequest',value);
  assert.equal(result.valid,false);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE_VALUE/);assert.deepEqual(value,saved);
  result.errors[0]!.message='caller changed';
  assert.notEqual(validateVisualInput('batchRequest',value).errors[0]!.message,'caller changed');
  assert.equal(validateVisualInput('toString' as VisualInputKind,{}).valid,false);
});
