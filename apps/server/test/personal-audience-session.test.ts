import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AudienceCoordinator,AudienceLeaseError,type AudienceIdentity,type PersonalSessionRequest,type CameraAudienceEvidence} from '../src/runtime/audience.ts';

test('original personal audience owner protects registration, scopes explicit commands and replay, withdraws at capacity and camera/current loss while phone leases remain bounded',()=>{
 let now=Date.parse('2026-10-14T00:00:00Z');const instances:AudienceCoordinator[]=[];
 const make=()=>{const c=new AudienceCoordinator({sourceIds:['owner-source'],cameraSourceIds:['camera'],now:()=>now,monotonicMs:()=>now});instances.push(c);return c;};
 const identity=():AudienceIdentity=>({principalId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID()});
 const command=(c:AudienceCoordinator,who:AudienceIdentity,operation:'lock'|'unlock',declarationId=randomUUID()):PersonalSessionRequest=>{const snapshot=c.personalSnapshot(who);return {operation,operationId:randomUUID(),declarationId,expectedAudienceRevision:snapshot.revision,expectedPersonalSessionEpoch:snapshot.personalSessionEpoch!,expectedSessionRevision:1,endpointId:who.endpointId!,expectedEndpointRevision:1};};
 const fails=(work:()=>unknown,code:string)=>assert.throws(work,e=>e instanceof AudienceLeaseError&&e.code===code);
 try{
  const c=make(),who=identity();let current=true;
  assert.equal(c.snapshot(who).privateAllowed,false);const protectedState=c.personalSnapshot(who);assert.equal(protectedState.personalSessionState,'locked');assert.equal(protectedState.privateAllowed,false);
  const unlock=command(c,who,'unlock');fails(()=>c.personalSession(who,{...unlock,extra:true} as PersonalSessionRequest,()=>current),'personal_session_invalid');
  fails(()=>c.personalSession(who,{...unlock,expectedPersonalSessionEpoch:randomUUID()},()=>current),'personal_session_source_changed');
  fails(()=>c.personalSession(who,{...unlock,endpointId:randomUUID()},()=>current),'personal_session_scope_changed');
  fails(()=>c.personalSession(who,{...unlock,expectedAudienceRevision:0},()=>current),'personal_session_revision_conflict');
  assert.equal(c.personalSession(who,unlock,()=>current).privateAllowed,true);now+=31*60*1000;
  assert.equal(c.snapshot(who).privateAllowed,true);assert.equal(c.snapshot(who).expiresAt,null);assert.equal(c.snapshot(who).leaseId,null);
  fails(()=>c.declare(who,'solo'),'personal_session_controls_required');
  const other=identity();c.personalSession(other,command(c,other,'lock'),()=>false);assert.equal(c.snapshot(who).privateAllowed,true);
  const lock=command(c,who,'lock',unlock.declarationId);lock.expectedAudienceRevision=0;
  assert.equal(c.personalSession(who,lock,()=>false).privateAllowed,false);
  fails(()=>c.personalSession(who,{...unlock,operationId:randomUUID(),expectedAudienceRevision:c.snapshot(who).revision},()=>true),'personal_session_retired');
  const successor=command(c,who,'unlock');assert.equal(c.personalSession(who,successor,()=>current).privateAllowed,true);
  assert.equal(c.personalSession(who,lock,()=>false).privateAllowed,true,'confirmed old Lock replay cannot withdraw a later explicit Unlock');
  fails(()=>c.personalSession(who,{...lock,expectedEndpointRevision:2},()=>false),'personal_session_command_conflict');
  current=false;assert.equal(c.snapshot(who).privateAllowed,false);current=true;
  fails(()=>c.personalSession(who,{...successor,operationId:randomUUID(),expectedAudienceRevision:c.snapshot(who).revision},()=>current),'personal_session_retired');
  const fresh=make();fails(()=>fresh.personalSession(who,successor,()=>true),'personal_session_source_changed');

  const racing=make(),rwho=identity(),pending=command(racing,rwho,'unlock'),withdraw=command(racing,rwho,'lock',pending.declarationId),publications:boolean[]=[];
  racing.subscribe(rwho,value=>publications.push(value.privateAllowed));let cancel=true;
  assert.throws(()=>racing.personalSession(rwho,pending,()=>{if(cancel){cancel=false;racing.personalSession(rwho,withdraw,()=>false);}return true;}),e=>e instanceof AudienceLeaseError);
  assert.equal(publications.some(Boolean),false);assert.equal(racing.snapshot(rwho).privateAllowed,false);

  const capacity=make(),owner=identity(),first=command(capacity,owner,'unlock');capacity.personalSession(owner,first,()=>true);
  for(let i=0;i<999;i++)capacity.snapshot(identity());
  const moved={...owner,endpointId:randomUUID()},withdrawOld=command(capacity,owner,'lock',first.declarationId);
  assert.equal(capacity.personalSession(moved,withdrawOld,()=>false).privateAllowed,false,'entry capacity cannot refuse same-owner old-endpoint withdrawal');
  assert.equal(capacity.snapshot(owner).privateAllowed,false);
  const commands=make(),crow=identity();for(let i=0;i<256;i++)commands.personalSession(crow,command(commands,crow,'lock'),()=>false);
  fails(()=>commands.personalSession(crow,command(commands,crow,'unlock'),()=>true),'personal_session_retired');
  assert.equal(commands.personalSession(crow,command(commands,crow,'lock'),()=>false).privateAllowed,false);

  const camera=make(),cameraWho=identity(),binding={sourceId:'camera',sourceBindingRef:'synthetic-host',leaseId:randomUUID(),captureEpoch:randomUUID(),configurationRevision:1};
  camera.beginCamera(cameraWho,binding);now++;
  const evidence=(sequence:number,value:'one'|'multiple'):CameraAudienceEvidence=>({evidenceRef:'synthetic-count',sequence,value,capturedAtEarliest:new Date(now).toISOString(),capturedAtLatest:new Date(now).toISOString(),interpretedAt:new Date(now).toISOString(),expiresAt:new Date(now+2000).toISOString(),declaredFieldOfView:'Synthetic bounded frame only',coverage:'frameOnly',confidence:null,limitations:['No identity inferred'],uncertaintyReasons:[]});
  assert.equal(camera.observeCamera(cameraWho,binding,evidence(0,'one')),true);
  camera.requalifyCamera(cameraWho,{binding,expectedAudienceRevision:camera.snapshot(cameraWho).revision,ownerEvidence:{sourceId:'owner-source',evidenceRef:'synthetic-owner',endpointId:cameraWho.endpointId!,principalId:cameraWho.principalId,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+4000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1}});
  const cameraUnlock=command(camera,cameraWho,'unlock');assert.equal(camera.personalSession(cameraWho,cameraUnlock,()=>true).privateAllowed,true);
  now+=2001;assert.equal(camera.snapshot(cameraWho).privateAllowed,false,'existing camera expiry hook also withdraws manual disclosure');
  fails(()=>camera.personalSession(cameraWho,command(camera,cameraWho,'unlock'),()=>true),'personal_session_restricted');
  const conflict=make(),conflictWho=identity();conflict.personalSession(conflictWho,command(conflict,conflictWho,'unlock'),()=>true);
  conflict.beginCamera(conflictWho,binding);assert.equal(conflict.snapshot(conflictWho).privateAllowed,false);assert.equal(conflict.observeCamera(conflictWho,binding,evidence(0,'multiple')),true);assert.equal(conflict.snapshot(conflictWho).privateAllowed,false);

  const phone=make(),phoneWho=identity(),leaseId=randomUUID();const leased=phone.lease(phoneWho,{operation:'begin',leaseId,expectedAudienceRevision:phone.snapshot(phoneWho).revision},()=>true);
  assert.equal(leased.privateAllowed,true);assert.equal(Object.hasOwn(leased,'personalSessionEpoch'),false);
  now+=19000;assert.equal(phone.lease(phoneWho,{operation:'renew',leaseId,expectedAudienceRevision:leased.revision},()=>true).revision,leased.revision);
  now+=20000;assert.equal(phone.snapshot(phoneWho).privateAllowed,false);fails(()=>phone.lease(phoneWho,{operation:'renew',leaseId,expectedAudienceRevision:phone.snapshot(phoneWho).revision},()=>true),'audience_lease_inactive');
 }finally{for(const c of instances)c.close();}
});
