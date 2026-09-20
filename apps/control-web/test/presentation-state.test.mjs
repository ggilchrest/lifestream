import assert from 'node:assert/strict';
import test from 'node:test';
import {animationForState,stateForPresentation,validateAnimationClips,presentationStates} from '../presentation-state.js';

test('presentation preserves preparing, interruption, work and failure; silent generation cannot mean speaking',()=>{
 for(const state of ['listening','preparing','speaking','interrupted'])assert.equal(stateForPresentation({speechState:state,activity:'conversing'}),state);
 for(const activity of ['working','waiting'])assert.equal(stateForPresentation({speechState:'silent',activity}),activity);
 assert.equal(stateForPresentation({speechState:'speaking',activity:'error'}),'failure');
 assert.equal(stateForPresentation({speechState:'silent',activity:'conversing'}),'idle');
});
test('all declared mappings must exist exactly once, including mappings outside idle',()=>{
 for(const state of [...presentationStates,'mouthAmplitude']){
  const manifest={animations:{[state]:'chosen'}};
  assert.throws(()=>validateAnimationClips(manifest,[{name:'different'}]),/missing/);
  assert.throws(()=>validateAnimationClips(manifest,[{name:'chosen'},{name:'chosen'}]),/ambiguous/);
  validateAnimationClips(manifest,[{name:'chosen'}]);
 }
});
test('explicit mapping, idle fallback and no mapping remain distinguishable with bounded authored transitions',()=>{
 const manifest={animations:{idle:'rest',preparing:'ready'},transitionSeconds:.3};
 assert.deepEqual(animationForState(manifest,'preparing'),{requested:'preparing',effective:'preparing',clip:'ready',degraded:false,transitionSeconds:.3});
 assert.deepEqual(animationForState(manifest,'failure'),{requested:'failure',effective:'idle',clip:'rest',degraded:true,transitionSeconds:.3});
 assert.equal(animationForState({animations:{}},'listening').effective,null);
 assert.throws(()=>animationForState(manifest,'unrecognized'));
});
