// Production readiness/status closures with the actual one-use session owner.
// No native configuration, original checkpoint, provider or authenticated route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createUbuntuGameSession} from '../src/runtime/ubuntu-game-session.ts';
import {fixtureEpisode} from '../../../packages/runtime/test/fixtures/game-memory.ts';

const source=readFileSync(new URL('../src/runtime/ubuntu-game-backend.ts',import.meta.url),'utf8');
const begin=source.indexOf(' const ready='),end=source.indexOf('\n return Object.freeze({',begin);
assert.ok(begin>=0&&end>begin);
const body=stripTypeScriptTypes(source.slice(begin,end),{mode:'strip'})+'\nreturn {ready,status};';
function fixture({kind='c72-container'}={}){
 const scope=fixtureEpisode().scope;
 let current=true,sourceCurrent=true,inferenceCurrent=true,nativeState='approved',nativeChecks=0,profileChecks=0,starts=0;
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>current};
 const session=createUbuntuGameSession(scope,{maximumRunMs:90000,maximumPlanningSteps:1,inferenceMode:'supervisedForeground'});
 session.configure({broker:{},origin:'http://127.0.0.1:32123',database:{}});
 session.bindHandle({startClient(){starts++;},ready:async()=>{},completion:()=>new Promise(()=>{}),snapshot:()=>({pauseConfirmation:'confirmed'}),stop:async()=>{}});
 const consent={observations:true,campaignJournal:true,controllerInput:false,sharedInference:true};
 const dependencies={
  configuration:{sessionProfile:'qualification',nativeInstallation:{kind},nativeLaunch:{},attach:{pinsDigest:'a'.repeat(64)},inferenceMode:'supervisedForeground',maximumRunMs:90000},
  generalVision:false,interpretationReady:()=>false,scene:null,session,
  nativeApproval:{status:()=>({required:true,state:session.started()?'consumed':nativeState})},
  c72NativeReadiness:()=>{nativeChecks++;return sourceCurrent;},
  ports:{inferenceSelection:()=>({fixture:true})},
  supervisedGameProviderAvailable:()=>inferenceCurrent,qualifiedGameInferenceBounds:()=>null,
  inferenceQualificationFor:()=>null,gameInferenceSelectionDigest:()=> 'fixture-selection',
  authority:{canStart:()=>true},composition:undefined,bounds:{modelCallBudget:1,actionBudget:1,frameBudget:1},
  check:()=>{profileChecks++;},identity:value=>value,admission:{status:()=>{throw Error('Already bound');}}
 };
 const actual=compileFunction(body,Object.keys(dependencies))(...Object.values(dependencies));
 return {...actual,actor,session,scope,consent,
  counts:()=>({nativeChecks,profileChecks,starts}),
  source:value=>{sourceCurrent=value;},inference:value=>{inferenceCurrent=value;},
  native:value=>{nativeState=value;},withdraw:()=>{current=false;},
  start:()=>session.start(actor,consent)
 };
}

test('each prelaunch status validates native facts exactly once and never caches a successful result',()=>{
 const f=fixture();const first=f.status(f.actor);
 assert.equal(first.configurationReady,true);assert.equal(first.readyForStart,true);assert.equal(first.readinessReason,null);
 assert.equal(f.counts().nativeChecks,1);
 f.source(false);const changed=f.status(f.actor);
 assert.equal(changed.configurationReady,false);assert.equal(changed.readyForStart,false);assert.match(changed.readinessReason,/Native facts/);
 assert.equal(f.counts().nativeChecks,2);
 f.source(true);assert.equal(f.status(f.actor).configurationReady,true);assert.equal(f.counts().nativeChecks,3);
});

test('prelaunch readiness still requires current inference and explicit native approval for Start',()=>{
 const f=fixture();f.inference(false);
 assert.equal(f.status(f.actor).readyForStart,false);assert.equal(f.counts().nativeChecks,1);
 f.inference(true);f.native('pending');const pending=f.status(f.actor);
 assert.equal(pending.configurationReady,true);assert.equal(pending.readyForStart,false);assert.match(pending.readinessReason,/explicitly approve/);
 assert.equal(f.counts().nativeChecks,2);
});

test('consuming the actual session skips native prelaunch reads without reopening Start',async()=>{
 const f=fixture();await f.start();assert.equal(f.session.started(),true);
 for(let i=0;i<100;i++){
  const status=f.status(f.actor);assert.equal(status.started,true);assert.equal(status.configurationReady,false);assert.equal(status.readyForStart,false);assert.equal(status.current,true);
 }
 assert.equal(f.counts().nativeChecks,0);assert.equal(f.counts().profileChecks,100);assert.equal(f.counts().starts,1);
 assert.equal(f.ready(),false);assert.equal(f.counts().nativeChecks,0);
 await assert.rejects(f.start(),error=>error.code==='game_session_start_unavailable');assert.equal(f.counts().starts,1);
});

test('retirement and actor withdrawal remain visible while consumed readiness stays false',async()=>{
 const f=fixture();await f.start();f.session.retire();f.withdraw();
 const status=f.status(f.actor);
 assert.equal(status.started,true);assert.equal(status.current,false);assert.equal(status.contextReady,false);assert.equal(status.state,'stopped');assert.equal(status.configurationReady,false);assert.equal(status.readyForStart,false);
 assert.equal(f.counts().nativeChecks,0);assert.equal(f.counts().profileChecks,1);
 const stranger={...f.actor,principalId:'different-principal'};
 assert.throws(()=>f.status(stranger),error=>error.code==='game_session_scope_denied');
 assert.equal(f.counts().profileChecks,2);
});

test('non-C72 installation readiness keeps its existing behavior after Start',async()=>{
 const f=fixture({kind:'other-test-installation'});await f.start();
 const status=f.status(f.actor);assert.equal(status.configurationReady,true);assert.equal(status.readyForStart,false);assert.equal(f.counts().nativeChecks,0);
});
