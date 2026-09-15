import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {loadMigrations} from '../src/migrations/index.ts';
import {InitiativeDeliveryRepository,type InitiativeScope,type InitiativeOpportunity} from '../src/initiative-delivery.ts';
import {InitiativeExpressionRepository,type InitiativeExpression} from '../src/initiative-expression.ts';
const start=Date.parse('2026-09-15T00:00:00Z'),scope:InitiativeScope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()};
const report=():InitiativeExpression=>({requestedWarmth:0.5,modality:'speech',wording:'requested',speechStage:'notObserved',mappingRevision:null,disposition:'notObserved',degradedDimensions:[],appliedDelivery:{}});
function setup(db:Database){let now=start;const ledger=new InitiativeDeliveryRepository(db,()=>now),expressions=new InitiativeExpressionRepository(db,()=>now),op:InitiativeOpportunity={schemaVersion:'1.0.0',recordType:'opportunity',...scope,opportunityId:randomUUID(),correlationId:randomUUID(),conversationId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID(),configurationId:randomUUID(),configurationRevision:1,policyRevision:'synthetic-policy:1',kind:'availableCheckIn',category:'social',urgency:'low',sourceKind:'simulatedBrowser',sourceRefs:['synthetic-source:expression'],executionMode:'simulation',observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),dedupKey:randomUUID(),topicKey:randomUUID()};
 let record=ledger.admit(scope,op,()=>true);return {ledger,expressions,op,time:(value:number)=>{now=value;},emit:()=>{for(const action of [{type:'eligible'},{type:'generated',preparedViewId:randomUUID(),interactionId:randomUUID()},{type:'queue',limits:{perHour:2,perDay:8,minimumGapMs:120000},current:()=>true},{type:'beginEmission',receiptId:op.correlationId,current:()=>true},{type:'emitted',receiptId:op.correlationId}] as const)record=ledger.transition(scope,op.opportunityId,record.version,action);return record;}};
}

test('expression observations are scoped, bounded and cannot claim emission before the delivery record',()=>{
 const db=new Database({path:':memory:'});db.migrate();const f=setup(db),id=f.op.opportunityId;
 try{
  const first=f.expressions.note(scope,id,report(),()=>true);assert.equal(first.revision,1);assert.equal(f.ledger.get(scope,id)!.version,1);first.report.requestedWarmth=1;assert.equal(f.expressions.get(scope,id)!.report.requestedWarmth,0.5);
  for(const key of ['assistantId','userId','relationshipId','deploymentId']){const other={...scope,[key]:randomUUID()};assert.equal(f.expressions.get(other,id),undefined);assert.throws(()=>f.expressions.note(other,id,report(),()=>true),/scope/u);}
  assert.throws(()=>f.expressions.note(scope,id,report(),()=>false),/scope/u);assert.throws(()=>f.expressions.note(scope,randomUUID(),report(),()=>true),/scope/u);
  for(const invalid of [{...report(),text:'PROVIDER_PROSE'},{...report(),requestedWarmth:2},{...report(),mappingRevision:'private prose is not a mapping'},{...report(),degradedDimensions:['invalid dimension']},{...report(),appliedDelivery:{text:'PROVIDER_PROSE'}},{...report(),modality:'text'},{...report(),wording:'emitted',speechStage:'audioEmitted'}])assert.throws(()=>f.expressions.note(scope,id,invalid as InitiativeExpression,()=>true));
  assert.equal(f.expressions.get(scope,id)!.revision,1);assert.equal(String(db.connection.prepare('SELECT report_json FROM initiative_expression').get()!.report_json).includes('PROVIDER_PROSE'),false);
 }finally{db.close();}
});

test('expression observations retain reported controls without regressing stages or extending opportunity retention',()=>{
 const db=new Database({path:':memory:'});db.migrate();const f=setup(db),id=f.op.opportunityId;
 try{
  f.expressions.note(scope,id,report(),()=>true);const header:InitiativeExpression={...report(),speechStage:'providerReported',mappingRevision:'synthetic-map:2',disposition:'partiallyApplied',degradedDimensions:['warmth','affect'],appliedDelivery:{deliveryMode:'neutral',pace:0.5,energy:0.4}};f.expressions.note(scope,id,header,()=>true);const emitted=f.emit(),complete:InitiativeExpression={...header,wording:'emitted',speechStage:'synthesized'};f.expressions.note(scope,id,complete,()=>true);
  for(const invalid of [{...complete,speechStage:'audioEmitted'},{...complete,wording:'requested'},{...complete,mappingRevision:'another-map:1'},{...complete,requestedWarmth:0.9},{...complete,degradedDimensions:[]},{...complete,appliedDelivery:{pace:0.9}}])assert.throws(()=>f.expressions.note(scope,id,invalid as InitiativeExpression,()=>true),/regress|unobserved/u);
  f.time(start+60000);assert.throws(()=>f.expressions.note(scope,id,complete,()=>true),/expired/u);f.time(start-1);assert.throws(()=>f.expressions.note(scope,id,complete,()=>true),/clock/u);f.time(start);f.ledger.transition(scope,id,emitted.version,{type:'finish',state:'unknown',reasons:['ackTimeout']});assert.throws(()=>f.expressions.note(scope,id,complete,()=>true),/terminal/u);assert.deepEqual(f.expressions.get(scope,id)!.report,complete);
  f.time(start+86400001);f.ledger.prune();assert.equal(f.expressions.get(scope,id),undefined);assert.equal(db.connection.prepare('SELECT count(*) AS n FROM initiative_expression').get()!.n,0);
 }finally{db.close();}
});

test('expression migration preserves existing delivery records and observations survive restart without output replay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'initiative-expression-upgrade-')),path=join(dir,'db.sqlite');let db=new Database({path,migrations:loadMigrations().filter(m=>m.id<=25)});const migrations=db.migrate(),f=setup(db),before=f.ledger.get(scope,f.op.opportunityId);db.close();
 try{
  db=new Database({path});const upgraded=db.migrate();assert.deepEqual(upgraded.slice(0,migrations.length),migrations);assert.deepEqual(upgraded.slice(migrations.length).map(m=>m.id),[26,27,28,29]);const ledger=new InitiativeDeliveryRepository(db,()=>start),expressions=new InitiativeExpressionRepository(db,()=>start);assert.deepEqual(ledger.get(scope,f.op.opportunityId),before);assert.equal(expressions.get(scope,f.op.opportunityId),undefined);expressions.note(scope,f.op.opportunityId,report(),()=>true);db.close();
  db=new Database({path});db.migrate();assert.deepEqual(new InitiativeExpressionRepository(db).get(scope,f.op.opportunityId)!.report,report());assert.deepEqual(new InitiativeDeliveryRepository(db).get(scope,f.op.opportunityId),before);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
