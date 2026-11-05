import test from 'node:test';
import assert from 'node:assert/strict';
import {runGameObservationCommand} from '../src/runtime/game-observation-deadline.ts';
function clocks(t){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});let mono=1000;
 t.mock.method(performance,'now',()=>mono);
 return ms=>{mono+=ms;t.mock.timers.tick(ms);};
}
test('one60s allowance covers delayed custody and native return without renewing deadline',async t=>{
 const advance=clocks(t);let release,context,archived=0;
 const work=runGameObservationCommand(60000,new AbortController().signal,async c=>{context=c;await new Promise(resolve=>{release=resolve;});c.check();archived++;return 'actual-controlled-result';});
 await Promise.resolve();const original=context.deadlineAt;advance(46000);release();assert.equal(await work,'actual-controlled-result');assert.equal(context.deadlineAt,original);assert.equal(Date.parse(original)-Date.now(),14000);assert.equal(archived,1);
 // This later operator-review wait lies outside the completed command timer.
 advance(120000);assert.equal(archived,1);
});
test('stuck initial custody is aborted at original deadline and late continuation cannot archive',async t=>{
 const advance=clocks(t);let release,signal,archives=0;
 const work=runGameObservationCommand(1000,new AbortController().signal,async c=>{signal=c.signal;await new Promise(resolve=>{release=resolve;});c.check();archives++;return null;});
 const refused=assert.rejects(work,error=>error.code==='timedOut');await Promise.resolve();advance(1000);await refused;assert.equal(signal.aborted,true);release();await Promise.resolve();await Promise.resolve();assert.equal(archives,0);
});
test('original parent cancellation is immediate and late result never receives publication authority',async t=>{
 clocks(t);const parent=new AbortController();let release,archives=0;
 const work=runGameObservationCommand(60000,parent.signal,async c=>{await new Promise(resolve=>{release=resolve;});c.check();archives++;return null;});
 const refused=assert.rejects(work,error=>error.code==='cancelled');await Promise.resolve();parent.abort();await refused;release();await Promise.resolve();await Promise.resolve();assert.equal(archives,0);
});
test('synchronous postresponse validation overrun refuses before archive callback',async t=>{
 const advance=clocks(t);let archives=0;
 await assert.rejects(runGameObservationCommand(1000,new AbortController().signal,async c=>{advance(1001);c.check();archives++;return null;}),error=>error.code==='timedOut');assert.equal(archives,0);
});
test('clock reversal and invalid watchdogs fail closed without entering work',async t=>{
 const advance=clocks(t);let entered=0;
 for(const budget of [0,-1,NaN,Infinity,1.5,120001,'60000'])await assert.rejects(runGameObservationCommand(budget,new AbortController().signal,async()=>{entered++;}));assert.equal(entered,0);
 await assert.rejects(runGameObservationCommand(60000,new AbortController().signal,async c=>{t.mock.timers.setTime(99999);c.check();}),error=>error.code==='scopeChanged');
});
