import test from 'node:test';import assert from 'node:assert/strict';
import {mobileControlPin,mobileControlRequestDigest,mobileControlSettlement} from '../src/mobile-context-control.ts';
import {ordinaryControlPin,ordinaryControlRequest,ordinaryControlReservationDigest} from '../src/mobile-context-control-settlement.ts';
import {removalControlPin,removalControlRequest,removalControlEnvelope,removalControlReservationDigest,removalControlResponse,removalControlSettlement,removalControlTerminalIdentity} from '../src/mobile-context-removal-settlement.ts';
const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const request=():any=>({schemaVersion:'1.0.0',operationId:id(1),target:{principalId:id(2),endpointId:id(3),collector:'healthKit',enrollmentId:id(4),sourceNamespace:id(5),expectedRevision:3},action:{kind:'remove',scope:'wholeSource'}});
function terminal(r=request()):any{
 const enrollment={enrollmentId:id(4),principalId:id(2),endpointId:id(3),collector:'healthKit',sourceNamespace:id(5),revision:4,state:'active',configuration:{categories:['SleepSegment'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true}};
 const control={schemaVersion:'1.0.0',producerPin:mobileControlPin,result:{originalRequest:structuredClone(r),requestDigest:mobileControlRequestDigest(r),status:'applied',current:{state:'current',policyRevision:4},receipt:{receiptId:id(6),committedAt:'2026-11-05T00:00:00.000Z',durability:'sqlCommit',result:{kind:'remove',scope:'wholeSource',enrollment,removedCount:1,suppressionEpoch:1,suppressionCommitted:true}}}};
 return {schemaVersion:'1.0.0',producerPin:removalControlPin,result:{kind:'terminal',binding:{family:'sourceRemovalControl',reservationDigest:removalControlReservationDigest(r),preparedDigest:'b'.repeat(64),terminalDigest:'c'.repeat(64)},control}};
}
test('independent removal producer leaves fb854 and7819 unchanged and admits only exact remove originals',()=>{
 assert.equal(mobileControlPin.digest,'fb854a621ce9fa2985047ded9ebeea6c094b108563e761fef431b02eec5853e3');assert.equal(ordinaryControlPin.digest,'7819f41352b0c298c29a26c9e3939f9967b7bddf029ee008e4d6562fe3c8ebf4');
 assert(removalControlRequest(request()));assert.equal(ordinaryControlRequest(request()),null);assert.equal(ordinaryControlReservationDigest(request()),null);
 assert(removalControlEnvelope({producerPin:removalControlPin,operation:'control',payload:request()}));assert.equal(removalControlEnvelope({producerPin:ordinaryControlPin,operation:'control',payload:request()}),null);
 for(const action of [{kind:'remove',scope:'selection'},{kind:'enroll'},{kind:'configure',state:'disconnected',configuration:{categories:[],uses:[],assistantIds:[],collectionPaused:true,usePaused:true}}])assert.equal(removalControlRequest({...request(),action}),null);
});
test('initial applied observation is held; only separately reconciled typed new family terminal settles',()=>{
 const r=request(),v=terminal(r);assert(removalControlResponse(v));assert.equal(mobileControlSettlement(r,v.result.control),'applied');assert.equal(removalControlSettlement(r,v),'applied');
 const observed={...v,result:{kind:'observed',control:v.result.control}};assert(removalControlResponse(observed));assert.equal(removalControlSettlement(r,observed),'held');assert.equal(removalControlTerminalIdentity(r,observed),null);
 for(const reason of ['pending','unknown','unqualified','otherFamily','unavailable'])assert.equal(removalControlSettlement(r,{...v,result:{kind:'held',reason}}),'held');
});
test('terminal requires complete independent family binding and typed suppression receipt',()=>{
 for(const key of ['reservationDigest','preparedDigest','terminalDigest','family']){const v=terminal();delete v.result.binding[key];assert.equal(removalControlResponse(v),null);}
 for(const family of ['ordinaryControl','calendarControl',null]){const v=terminal();v.result.binding.family=family;assert.equal(removalControlResponse(v),null);}
 const bad=terminal();bad.result.binding.reservationDigest='0'.repeat(64);assert.equal(removalControlResponse(bad),null);
 for(const key of ['suppressionEpoch','suppressionCommitted','removedCount']){const v=terminal();delete v.result.control.result.receipt.result[key];assert.equal(removalControlResponse(v),null);}
 const zero=terminal();zero.result.control.result.receipt.result.removedCount=0;zero.result.control.result.receipt.result.suppressionEpoch=0;assert.equal(removalControlSettlement(request(),zero),'applied');
});
test('exact original scope and historical receipt truth remain separate from current permissions',()=>{
 const r=request(),v=terminal(r),identity=removalControlTerminalIdentity(r,v);assert(identity);
 for(const key of ['principalId','endpointId','enrollmentId','sourceNamespace','expectedRevision']){const other=structuredClone(r);other.target[key]=key==='expectedRevision'?4:id(9);assert.equal(removalControlSettlement(other,v),'held');}
 v.result.control.result.current={state:'unavailable',policyRevision:null};assert.equal(removalControlSettlement(r,v),'applied');assert.equal(removalControlTerminalIdentity(r,v),identity);
});
test('pending or rejected base outcomes cannot become new removal terminals and hostile input stays inert',()=>{
 for(const status of ['pending','unknown','rejected']){const v=terminal();v.result.control.result.status=status;delete v.result.control.result.receipt;assert.equal(removalControlResponse(v),null);}
 let invoked=0;const accessor={get schemaVersion(){invoked++;return '1.0.0';}};assert.equal(removalControlRequest(accessor),null);assert.equal(invoked,0);
 assert.equal(removalControlEnvelope({...terminal(),payload:'x'.repeat(131073)}),null);
});
