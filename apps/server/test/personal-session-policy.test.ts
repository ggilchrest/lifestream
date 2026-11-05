import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {LocalAuthentication,AuthenticationError,INACTIVE_PERSONAL_DAILY_SESSION_POLICY,type LocalAuthOptions} from '../src/auth/local-auth.ts';

const origin='http://127.0.0.1:33000';
const secret=()=>`TEST-${randomBytes(24).toString('hex')}`;
const policy={...INACTIVE_PERSONAL_DAILY_SESSION_POLICY,enabled:true};
function fixture(t:TestContext,enabled=true){
 const root=mkdtempSync(join(tmpdir(),'ls-persistent-policy-')),database=new Database({path:join(root,'test.sqlite')});database.migrate();let now=1_800_000_000_000;
 const options:LocalAuthOptions={stateDirectory:join(root,'safety'),installerToken:secret(),now:()=>now,personalSessionPolicy:{...policy,enabled}};
 const auth=new LocalAuthentication(database,options);t.after(()=>{database.close();rmSync(root,{recursive:true,force:true});});
 return {database,options,auth,advance:(ms:number)=>{now+=ms;}};
}
test('explicit inactive policy retains the exact default administrator expiry',async t=>{
 const f=fixture(t,false),setup=await f.auth.setup('owner',secret(),f.options.installerToken!,origin);
 assert.equal(typeof setup.session.adminExpiresAt,'string');assert.equal(setup.session.sessionPolicy,undefined);
 f.advance(1_800_000);assert.equal(f.auth.context(setup.session.token,origin),undefined);assert.ok(f.auth.context(setup.session.token,origin,false));
});
test('only the enrolled owner retains current administration across long idle and authentication reconstruction',async t=>{
 const f=fixture(t),password=secret(),setup=await f.auth.setup('owner',password,f.options.installerToken!,origin),owner=f.auth.context(setup.session.token,origin)!;
 assert.equal(owner.expiresAt,null);assert.equal(setup.session.adminExpiresAt,null);assert.deepEqual(setup.session.sessionPolicy,{schemaVersion:'personal-daily-session-policy/1',scope:'installationOwner',expiration:'untilRevoked',windowFocusRequired:false});
 const memberPassword=secret();await f.auth.provision(owner,'member',memberPassword);const member=await f.auth.signIn('member',memberPassword,'',origin,'loopback');
 f.advance(100*365*24*60*60*1000);
 assert.equal(f.auth.assertCurrent(owner),owner);assert.equal(f.auth.renewCsrf(owner),setup.session.csrfToken);
 assert.equal(f.auth.context(member.token,origin),undefined);assert.ok(f.auth.context(member.token,origin,false));
 const restarted=new LocalAuthentication(f.database,f.options),current=restarted.context(setup.session.token,origin)!;assert.equal(current.expiresAt,null);assert.equal(restarted.assertCurrent(current),current);
 assert.equal(restarted.context(setup.session.token,'http://127.0.0.1:33001'),undefined);
 assert.throws(()=>restarted.csrf(current,'TEST-wrong-CSRF'),/csrf rejected/);
 await assert.rejects(restarted.beginMfa(current,'TEST-wrong-password'),error=>error instanceof AuthenticationError&&error.code==='mfa_enrollment_denied');
});
test('captured finite contexts never gain persistence, and captured null contexts cannot survive disabling it',async t=>{
 const f=fixture(t,false),setup=await f.auth.setup('owner',secret(),f.options.installerToken!,origin),finite=f.auth.context(setup.session.token,origin)!;f.advance(1_800_001);
 const enabled=new LocalAuthentication(f.database,{...f.options,personalSessionPolicy:policy});
 assert.throws(()=>enabled.assertCurrent(finite),AuthenticationError);
 const current=enabled.context(setup.session.token,origin)!;assert.equal(current.expiresAt,null);
 const disabled=new LocalAuthentication(f.database,f.options);assert.throws(()=>disabled.assertCurrent(current),AuthenticationError);
 assert.ok(disabled.context(setup.session.token,origin,false));assert.equal(disabled.context(setup.session.token,origin),undefined);
});
test('sign-out and credential rotation revoke persistent sessions across reconstruction',async t=>{
 const f=fixture(t),password=secret(),setup=await f.auth.setup('owner',password,f.options.installerToken!,origin),context=f.auth.context(setup.session.token,origin)!;
 f.advance(90*24*60*60*1000);f.auth.logout(context);assert.equal(new LocalAuthentication(f.database,f.options).context(setup.session.token,origin,false),undefined);
 const session=await f.auth.signIn('owner',password,'',origin,'loopback'),actor=f.auth.context(session.token,origin)!;
 await f.auth.rotateRecoveryCodes(actor,password);assert.equal(new LocalAuthentication(f.database,f.options).context(session.token,origin,false),undefined);
});
test('policy is closed data, inactive by omission, and captured immutably',async t=>{
 const f=fixture(t,false);let getterCalls=0;
 const getter={...policy};Object.defineProperty(getter,'enabled',{enumerable:true,get(){getterCalls++;return true;}});
 for(const value of [{...policy,extra:true},{...policy,scope:'allAccounts'},{...policy,windowFocusRequired:true},getter])assert.throws(()=>new LocalAuthentication(f.database,{...f.options,personalSessionPolicy:value as any}),/personal session policy invalid/);
 assert.equal(getterCalls,0);
 const mutable={...policy,enabled:false},auth=new LocalAuthentication(f.database,{...f.options,personalSessionPolicy:mutable});mutable.enabled=true;
 const setup=await auth.setup('owner',secret(),f.options.installerToken!,origin);assert.equal(typeof setup.session.adminExpiresAt,'string');
 const omitted=new LocalAuthentication(f.database,{stateDirectory:f.options.stateDirectory,now:f.options.now});assert.equal(typeof omitted.context(setup.session.token,origin)!.expiresAt,'string');
});
