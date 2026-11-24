import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {releasePresentation} from '../../control-web/presentation-core.js';
import {prepareMobileAppearance,persistMobileAppearanceSelection,commitMobileAppearance} from '../web/mobile-appearance-transition.js';
function fixture(){
 const events=[],root=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()),texture=new THREE.Texture({close(){events.push('bitmap-close');}});root.material.map=texture;
 texture.addEventListener('dispose',()=>events.push('texture-dispose'));root.geometry.addEventListener('dispose',()=>events.push('geometry-dispose'));
 const previous={root,adapter:{dispose(){events.push('adapter-dispose');}},urls:[]};
 const runtime={current:previous,currentItem:{id:'old'},scene:{},camera:{},neutral:()=>({root:new THREE.Group(),id:'neutral'}),release:releasePresentation,
 commit(value){const old=this.current;this.current=value;this.release(old);},renderer:{renderLists:{dispose(){events.push('render-lists-clear');}},render(){events.push('neutral-render');}}};
 return {runtime,previous,events};
}
test('direct replacement releases previous decoded/GPU owners before retrieving the next model',async()=>{
 const {runtime,previous,events}=fixture(),next={id:'next',root:new THREE.Group()},signal=new AbortController().signal;
 const candidate=await prepareMobileAppearance(runtime,next,signal,async(item,received)=>{
  assert.equal(received,signal);assert.equal(previous.released,true);assert.equal(runtime.current.id,'neutral');assert.deepEqual(events,['adapter-dispose','geometry-dispose','bitmap-close','texture-dispose','render-lists-clear','neutral-render']);return next;
 });assert.equal(candidate,next);assert.equal(runtime.currentItem.id,'neutral');assert.equal(runtime.preparingAppearance,false);runtime.commit(candidate);assert.equal(runtime.current,next);
});
test('prepare failure leaves a usable neutral display and allows retry',async()=>{
 const {runtime}=fixture();await assert.rejects(prepareMobileAppearance(runtime,{id:'next'},null,async()=>{throw Error('invalid model');}),/invalid model/);
 assert.equal(runtime.current.id,'neutral');assert.equal(runtime.preparingAppearance,false);
 const retry=await prepareMobileAppearance(runtime,{id:'retry'},null,async()=>({id:'retry'}));assert.equal(retry.id,'retry');
});
test('already-cancelled transition retains current graph; cancellation during yield never fetches',async()=>{
 for(const before of [true,false]){const {runtime,previous}=fixture(),abort=new AbortController();let fetched=0;if(before)abort.abort();const task=prepareMobileAppearance(runtime,{},abort.signal,async()=>{fetched++;});if(!before)abort.abort();await assert.rejects(task,{name:'AbortError'});assert.equal(fetched,0);assert.equal(previous.released===true,!before);assert.equal(runtime.preparingAppearance===true,false);}
});
for(const reason of ['abort','dispose','context-loss'])test(`late model is released after ${reason} and never committed`,async()=>{
 const {runtime}=fixture(),abort=new AbortController();let resolve,ready;const entered=new Promise(r=>ready=r),candidate={root:new THREE.Group()};
 const task=prepareMobileAppearance(runtime,{},abort.signal,()=>{ready();return new Promise(r=>resolve=r);});await entered;
 if(reason==='abort')abort.abort();else if(reason==='dispose')runtime.disposed=true;else runtime.contextLost=true;
 resolve(candidate);await assert.rejects(task);assert.equal(candidate.released,true);assert.equal(runtime.current.id,'neutral');assert.equal(runtime.preparingAppearance,false);
});
test('concurrent transitions refuse before releasing a second graph',async()=>{
 const {runtime}=fixture();let finish,ready;const entered=new Promise(r=>ready=r),task=prepareMobileAppearance(runtime,{},null,()=>{ready();return new Promise(r=>finish=r);});await entered;
 await assert.rejects(prepareMobileAppearance(runtime,{},null,()=>{}),/already loading/);finish({root:new THREE.Group()});await task;assert.equal(runtime.preparingAppearance,false);
});

test('successful settings write stores exact identity, while rejected write restores previous selection',async()=>{
 const previous={id:'previous',digest:'previous-digest'},selections=new Map([['assistant',previous]]),item={id:'next',digest:'next-digest'};
 await assert.rejects(persistMobileAppearanceSelection(selections,'assistant',item,async()=>{assert.deepEqual(selections.get('assistant'),item);throw Error('storage failure');}),/storage failure/);assert.equal(selections.get('assistant'),previous);
 await persistMobileAppearanceSelection(selections,'assistant',item,async()=>{});assert.deepEqual(selections.get('assistant'),item);
 await assert.rejects(persistMobileAppearanceSelection(selections,'new-assistant',item,async()=>{throw Error('storage failure');}));assert.equal(selections.has('new-assistant'),false);
});
test('rejected old settings write cannot restore a cleared or replacement account preference',async()=>{
 const selections=new Map([['assistant',{id:'old'}]]);let reject,ready;const started=new Promise(r=>ready=r);
 const task=persistMobileAppearanceSelection(selections,'assistant',{id:'next',digest:'digest'},()=>{ready();return new Promise((_,r)=>reject=r);});await started;selections.clear();selections.set('assistant',{id:'new-account'});reject(Error('retired'));await assert.rejects(task);assert.deepEqual(selections.get('assistant'),{id:'new-account'});
});

for(const reason of ['abort','dispose','context-loss','privacy'])test(`settings completion cannot commit after ${reason}`,async()=>{
 const {runtime}=fixture(),signal=new AbortController(),selections=new Map();let finish,ready,current=true;const entered=new Promise(r=>ready=r),candidate={id:'next',root:new THREE.Group()};
 const task=(async()=>{try{await persistMobileAppearanceSelection(selections,'assistant',{id:'next',digest:'digest'},()=>{ready();return new Promise(r=>finish=r);});commitMobileAppearance(runtime,{id:'next'},candidate,signal.signal,()=>current);}finally{if(runtime.current!==candidate)runtime.release(candidate);}})();await entered;
 if(reason==='abort')signal.abort();else if(reason==='dispose')runtime.disposed=true;else if(reason==='context-loss')runtime.contextLost=true;else current=false;
 finish();await assert.rejects(task);assert.notEqual(runtime.current,candidate);assert.equal(candidate.released,true);
});
test('current display commits after successful persistence with no asynchronous guard gap',()=>{
 const {runtime}=fixture(),candidate={root:new THREE.Group()},item={id:'next'};commitMobileAppearance(runtime,item,candidate,new AbortController().signal,()=>true);assert.equal(runtime.current,candidate);assert.equal(runtime.currentItem,item);
});
