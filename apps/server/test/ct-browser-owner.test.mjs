import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {compileFunction} from 'node:vm';
import {AuthenticationError} from '../src/auth/local-auth.ts';
import {createCtBrowserOwnerRendezvous as create} from '../src/runtime/ct-browser-owner.ts';
function fixture(t){let now=Date.now(),valid=true,allowed=true,opened=0,closed=0;const actual={id:'TEST-original-request',identity:'TEST-private-internal-binding',method:'POST'};
 const owner={close(){closed++;}},r=create({now:()=>now,expiresAt:now+60000,current(){if(!valid)throw new AuthenticationError(409,'TEST_original_scope_retired');},qualify(request){if(!allowed)throw new AuthenticationError(403,'administration_freshness_required');return {identity:request.identity,assertCurrent(){if(!valid)throw new AuthenticationError(409,'TEST_original_scope_retired');}};},open(request){assert.equal(request,actual);opened++;return owner;}});
 t.after(()=>r.close());return {r,actual,owner,counts:()=>({opened,closed}),advance:ms=>now+=ms,retire:()=>valid=false,deny:()=>allowed=false};
}
test('GET qualification before worker arm is read-only and returns no authentication selector',t=>{const f=fixture(t),v=f.r.review(f.actual);assert.deepEqual(v,{schemaVersion:'ct-browser-owner-review/1',state:'waitingForWorker',canBind:false});assert.deepEqual(f.counts(),{opened:0,closed:0});assert(!JSON.stringify(v).includes('PRIVATE'));});
test('one current original request binds once after arm; challenge is not owner identity',async t=>{const f=fixture(t);f.r.arm();const v=f.r.review(f.actual);assert.match(v.challenge,/^[a-f0-9]{64}$/);assert(!JSON.stringify(v).includes(f.actual.identity));assert.deepEqual(f.r.accept(f.actual,{challenge:v.challenge}),{schemaVersion:'ct-browser-owner-review/1',state:'bound',canBind:false,nativeStarted:false});assert.equal(await f.r.owner(),f.owner);assert.throws(()=>f.r.accept(f.actual,{challenge:v.challenge}));await f.r.close();assert.deepEqual(f.counts(),{opened:1,closed:1});});
for(const body of [{},{challenge:'a'.repeat(64),sessionId:'TEST-forbidden'}, {challenge:'a'.repeat(64),actor:{}}, {challenge:'a'.repeat(64),configuration:{}}, {challenge:3},null,[]])test('closed POST rejects identity/configuration/unknown fields '+JSON.stringify(body),t=>{const f=fixture(t);f.r.arm();f.r.review(f.actual);assert.throws(()=>f.r.accept(f.actual,body));assert.equal(f.counts().opened,0);});
test('a newer review invalidates the earlier challenge; foreign request cannot inherit review',t=>{const f=fixture(t);f.r.arm();const old=f.r.review(f.actual),fresh=f.r.review(f.actual);assert.throws(()=>f.r.accept(f.actual,{challenge:old.challenge}));assert.throws(()=>f.r.accept({...f.actual,identity:'TEST-other-original-owner'},{challenge:fresh.challenge}));assert.equal(f.counts().opened,0);f.r.accept(f.actual,{challenge:fresh.challenge});});
for(const kind of ['expiry','backward','scope','freshness'])test('original '+kind+' retirement refuses before owner construction',t=>{const f=fixture(t);f.r.arm();const v=f.r.review(f.actual);if(kind==='expiry')f.advance(30001);if(kind==='backward')f.advance(-1);if(kind==='scope')f.retire();if(kind==='freshness')f.deny();assert.throws(()=>f.r.accept(f.actual,{challenge:v.challenge}));assert.equal(f.counts().opened,0);});
test('captured pre-body binding retires a delayed body; closure prevents late construction',async t=>{const f=fixture(t);f.r.arm();const v=f.r.review(f.actual),before=f.r.capture(f.actual);f.retire();assert.throws(()=>before.assertCurrent());assert.throws(()=>f.r.accept(f.actual,{challenge:v.challenge}));await f.r.close();await assert.rejects(f.r.owner());assert.equal(f.counts().opened,0);});
test('post-open retirement and repeated close await the same one owned cleanup',async()=>{let fail=false,release,closes=0;const cleanup=new Promise(r=>release=r),request={};const r=create({now:Date.now,expiresAt:Date.now()+60000,current(){},qualify:()=>({identity:'TEST-bound',assertCurrent(){if(fail)throw Error('TEST-retired');}}),open:()=>{fail=true;return {close(){closes++;return cleanup;}};}});r.arm();const v=r.review(request);assert.throws(()=>r.accept(request,{challenge:v.challenge}));let done=false;const first=r.close();assert.equal(r.close(),first);first.then(()=>done=true);await new Promise(r=>setImmediate(r));assert.equal(closes,1);assert.equal(done,false);release();await first;assert.equal(done,true);await assert.rejects(r.owner());});

test('explicit untimed preparation keeps original fresh challenges and a one-use original request',async t=>{
 let now=Date.now(),opens=0,closes=0;const abort=new AbortController(),request={},owner={close(){closes++;}};
 const r=create({now:()=>now,preparation:'untilCancelled',signal:abort.signal,current(){},qualify:()=>({identity:'TEST-original-bound-request',assertCurrent(){}}),open:()=>{opens++;return owner;}});t.after(()=>r.close());
 now+=365*24*60*60*1000;r.arm();const first=r.review(request);assert.equal(Date.parse(first.expiresAt),now+30000);assert.equal(opens,0);
 now+=24*60*60*1000;assert.throws(()=>r.accept(request,{challenge:first.challenge}),/review required/);const fresh=r.review(request);assert.equal(opens,0);
 r.accept(request,{challenge:fresh.challenge});assert.equal(await r.owner(),owner);assert.equal(opens,1);abort.abort();await r.close();assert.equal(closes,1);assert.throws(()=>r.review(request),/closed/);
});
test('untimed preparation requires original cancellation and stops waiting without a new request',async()=>{
 const ports={now:Date.now,current(){},qualify:()=>({identity:'TEST',assertCurrent(){}}),open:()=>{throw Error('must not construct');}};
 assert.throws(()=>create({...ports,preparation:'untilCancelled'}),/lifetime required/);assert.throws(()=>create({...ports,expiresAt:Infinity}),/lifetime required/);
 const abort=new AbortController(),r=create({...ports,preparation:'untilCancelled',signal:abort.signal});const pending=r.owner();abort.abort();await assert.rejects(pending,/closed/);assert.throws(()=>r.arm(),/closed/);await r.close();
});
