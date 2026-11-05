import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeExecutionLifetime,nativeExecutionLifetimeCurrent,nativeExecutionLifetimeSignal,nativeExecutionCustodyBounds} from '../src/native-execution-lifetime.ts';
function fixture(t:any){
 let wall=1000000,mono=100,current=true,checks=0;const controller=new AbortController();
 t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);
 const lifecycle=Object.freeze({signal:controller.signal,check:()=>{checks++;return current;}});
 return {lifecycle,controller,advance:(ms:number)=>{wall+=ms;mono+=ms;},wall:(value:number)=>{wall=value;},mono:(value:number)=>{mono=value;},revoke:()=>{current=false;},get checks(){return checks;}};
}
test('opaque native custody captures only original lifecycle and absolute authority; time never resets at review or gameplay entry',t=>{
 const f=fixture(t),until=new Date(Date.now()+120000).toISOString(),handle=createNativeExecutionLifetime(f.lifecycle,until);
 assert.equal(Object.isFrozen(handle),true);assert.deepEqual(JSON.parse(JSON.stringify(handle)),{});assert.equal(nativeExecutionLifetimeSignal(handle),f.controller.signal);
 f.advance(70000);assert.deepEqual(nativeExecutionCustodyBounds(handle),{schemaVersion:'ct-native-authority-lifetime/1',expiresAt:until,remainingMs:50000});
 f.advance(49999);assert.equal(nativeExecutionLifetimeCurrent(handle),true);f.advance(1);assert.equal(nativeExecutionLifetimeCurrent(handle),false);assert.throws(()=>nativeExecutionCustodyBounds(handle));
});
test('JSON lookalikes, arbitrary option callbacks, mutable/getter lifecycle and out-of-range authority refuse',t=>{
 const f=fixture(t);for(const fake of [{},JSON.parse('{}'),{check:()=>true,signal:f.controller.signal}])assert.equal(nativeExecutionLifetimeCurrent(fake as any),false);
 for(const value of [0,300001,Infinity])assert.throws(()=>createNativeExecutionLifetime(f.lifecycle,Number.isFinite(value)?new Date(Date.now()+value).toISOString():'never'));
 assert.throws(()=>createNativeExecutionLifetime({...f.lifecycle},new Date(Date.now()+100).toISOString()));
 let invoked=0;assert.throws(()=>createNativeExecutionLifetime(Object.freeze({get signal(){invoked++;return f.controller.signal;},get check(){invoked++;return ()=>true;}}),new Date(Date.now()+100).toISOString()));assert.equal(invoked,0);
});
test('original cancellation/currentness and either clock fence permanently retire native custody',t=>{
 for(const mode of ['cancel','current','wallRegression','monoRegression','wallExpiry','monoExpiry']){
  const f=fixture(t),handle=createNativeExecutionLifetime(f.lifecycle,new Date(Date.now()+100).toISOString());
  if(mode==='cancel')f.controller.abort();if(mode==='current')f.revoke();if(mode==='wallRegression')f.wall(Date.now()-1);if(mode==='monoRegression')f.mono(performance.now()-1);if(mode==='wallExpiry')f.wall(Date.now()+100);if(mode==='monoExpiry')f.mono(performance.now()+100);
  assert.equal(nativeExecutionLifetimeCurrent(handle),false,mode);assert.throws(()=>nativeExecutionLifetimeSignal(handle));t.mock.restoreAll();
 }
});


test('original check callback cannot report current after it aborts or crosses either authority clock',t=>{
 for(const mode of ['abort','wallExpiry','monoExpiry','wallRegression','monoRegression']){
  let wall=1000000,mono=100,act=false;const controller=new AbortController();t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);
  const lifecycle=Object.freeze({signal:controller.signal,check:()=>{if(act){if(mode==='abort')controller.abort();if(mode==='wallExpiry')wall+=100;if(mode==='monoExpiry')mono+=100;if(mode==='wallRegression')wall--;if(mode==='monoRegression')mono--;}return true;}});
  const handle=createNativeExecutionLifetime(lifecycle,new Date(wall+100).toISOString());act=true;assert.equal(nativeExecutionLifetimeCurrent(handle),false,mode);assert.throws(()=>nativeExecutionCustodyBounds(handle));t.mock.restoreAll();
 }
});

test('fresh explicit five-minute authority preserves original deadline across startup and gameplay, never renews old custody',t=>{
 const f=fixture(t),until=new Date(Date.now()+300000).toISOString(),handle=createNativeExecutionLifetime(f.lifecycle,until);
 f.advance(120000);assert.equal(nativeExecutionCustodyBounds(handle).remainingMs,180000);
 f.advance(90000);assert.equal(nativeExecutionCustodyBounds(handle).remainingMs,90000);
 f.advance(90000);assert.equal(nativeExecutionLifetimeCurrent(handle),false);assert.throws(()=>nativeExecutionCustodyBounds(handle));
});
