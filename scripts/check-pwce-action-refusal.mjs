import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadProfile} from '../apps/server/src/config/loader.ts';
import {PwceActionPreparation} from '../apps/server/src/authority/pwce-action-preparation.ts';
import {AuthenticationError} from '../apps/server/src/auth/local-auth.ts';
import {CapabilityCallError} from '../packages/runtime/dist/capabilities/call.js';
const producer=resolve(process.env.PWCE_PRODUCER_ROOT??'../PWCE');
const load=path=>import(pathToFileURL(join(producer,path)).href);
const {StateStore,emptyState}=await load('src/runtime/state-store.js');
const {ActionService}=await load('src/actions/action-service.js');
const {ApprovalService}=await load('src/actions/approval-service.js');
const {createStudioHttpServer}=await load('src/http/dev-server.js');
async function gatewayApprovalFixture({ target = null, liveEffectsEnabled = false, executionEnvironmentRef = 'test' } = {}) {
  const secret = () => randomBytes(24).toString('hex'); let calls = 0, clockOffset = 0;
  const clock = () => new Date(Date.now() + clockOffset), store = new StateStore({ state: emptyState() });
  const approvals = new ApprovalService({ store, clock });
  const actions = new ActionService({ store, approvalService: approvals, clock, liveEffectsEnabled, target: target ?? { identity: 'synthetic-human-review-target', async invoke() { calls++; return { status: 'succeeded', externalEffectOccurred: true }; } } });
  const password = secret(), recoveryCode = secret(), studioToken = secret(), gatewayToken = secret(), dispatcherToken = secret();
  const env = { PWCE_STUDIO_USERNAME: 'synthetic-reviewer', PWCE_STUDIO_PASSWORD: password, PWCE_STUDIO_RECOVERY_CODES: recoveryCode, PWCE_STUDIO_TOKEN: studioToken, PWCE_GATEWAY_TOKEN: gatewayToken, PWCE_GATEWAY_DISPATCHER_TOKEN: dispatcherToken, PWCE_GATEWAY_SITE_REFS: 'home.one,home.two' };
  const service = { siteRef: 'home.one', siteRefs: ['home.one'], entityId: 'light.synthetic', actionService: actions, approvalService: approvals, runtimeStatus: () => ({ status: 'offline', reason: 'synthetic_review_fixture' }), stop() {} };
  const { server, gateway } = await createStudioHttpServer({ env, store, service });
  actions.registerGrant({ principalRef: 'agent.fixture', siteRefs: ['home.one','home.two'], capabilityRefs: ['home.light.set_level'] });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`; let cookie;
  const send = async (path, body, auth = 'human', extra = {}) => {
    const headers = { 'content-type': 'application/json', origin: base, ...(auth === 'human' && cookie ? { cookie } : {}), ...(auth === 'gateway' ? { authorization: `Bearer ${gatewayToken}` } : {}), ...(auth === 'studioToken' ? { authorization: `Bearer ${studioToken}` } : {}), ...extra };
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const identity = { assistantRef: 'assistant.synthetic', endpointRef: 'endpoint.synthetic', participantRefs: ['participant.synthetic'], audienceRef: 'audience.synthetic' };
  const authority = await send('/gateway/v1/authority', { siteRefs: ['home.one'], ...identity }, 'gateway');
  const scope = { ...identity, authorityContextRef: authority.body.authorityContextRef, executionEnvironmentRef };
  const payload = { ...scope, operation: 'capabilities.invoke', capabilityRef: 'home.light.set_level', capabilityVersion: '1.0.0', capabilityOperation: 'light.set_level', siteRef: 'home.one', targetEntityId: 'light.synthetic', parameters: { level: 0.4 }, approvalRequired: true, idempotencyKey: 'synthetic-reviewed-action' };
  return { base, password, recoveryCode, env, dispatcherToken, store, actions, approvals, identity, payload, send, calls: () => calls,
    prepare: extra => send('/gateway/v1/request', { ...payload, ...extra }, 'gateway'),
    async login(recovery = false) { const result = await send('/api/session', recovery ? { recoveryCode } : { username: env.PWCE_STUDIO_USERNAME, password }, 'none'); cookie = result.cookie; return result; },
    setCookie(value) { cookie = value; }, advance(ms) { clockOffset += ms; },
    async close() { gateway?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

// Unit coverage of error classification only: no successful permission result,
// owner, database, catalog, dispatcher or target is supplied by these doubles.
test('action preparation preserves all five bounded failure categories',async()=>{
 const preparation=new PwceActionPreparation(null,null,null);
 const cases=[['providerUnavailable',503,'pwce_preparation_unavailable'],['scopeChanged',409,'pwce_preparation_scope_changed'],['cancelled',409,'pwce_preparation_cancelled'],['timedOut',504,'pwce_preparation_timed_out'],['invalidResponse',502,'pwce_preparation_invalid_response']];
 for(const [kind,status,code] of cases){
  const original=new CapabilityCallError(kind);original.message='SYNTHETIC_PRIVATE_PROVIDER_TEXT';
  const provider={async withCatalog(){throw original;}};
  await assert.rejects(preparation.scoped(provider,null,null,async()=>assert.fail('no operation after rejected catalog')),error=>error instanceof AuthenticationError&&error.status===status&&error.code===code&&!error.message.includes('SYNTHETIC_PRIVATE_PROVIDER_TEXT'));
 }
});
test('action preparation keeps host validation and unclassified failures distinct',async()=>{
 const preparation=new PwceActionPreparation(null,null,null),host=new AuthenticationError(403,'assistant_scope_denied');
 const passingCatalog={async withCatalog(_owner,_call,operation){return operation({});}};
 await assert.rejects(preparation.scoped(passingCatalog,null,null,async()=>{throw host;}),error=>error===host);
 for(const original of [new Error('SYNTHETIC_INTERNAL_FAULT'),Object.assign(new Error('SYNTHETIC_FORGED_FAILURE'),{code:'providerUnavailable'})]){
  const provider={async withCatalog(){throw original;}};
  await assert.rejects(preparation.scoped(provider,null,null,async()=>assert.fail()),error=>error===original);
 }
});

async function reviewedAction(t,withdraw){
 let effects=0,targetChecks=0;const target={identity:'synthetic.review-target',async checkPreconditions(){targetChecks++;return {allowed:true,observed:{synthetic:true},reasonCode:'synthetic_ready'};},async invoke(){effects++;return {status:'succeeded',externalEffectOccurred:true};}};
 const priorMask=process.umask(0o077);t.after(()=>process.umask(priorMask));
 const f=await gatewayApprovalFixture({target,liveEffectsEnabled:true,executionEnvironmentRef:'live'});t.after(()=>f.close());const root=await mkdtemp(join(process.env.TMPDIR,'joined-action-refusal-'));let app;
 t.after(async()=>{delete process.env.PV1_TEST_AGENT;delete process.env.PV1_TEST_DISPATCHER;try{await app?.shutdown();}finally{await rm(root,{recursive:true,force:true});}});process.env.PV1_TEST_AGENT=f.env.PWCE_GATEWAY_TOKEN;process.env.PV1_TEST_DISPATCHER=f.dispatcherToken;
 const config=loadProfile('test');config.authority.authentication='local-password';config.providers.world='pwce';config.providers.capability='pwce';config.authority.provider='pwce';config.secretRefs={gateway:{kind:'env',name:'PV1_TEST_AGENT'},dispatcher:{kind:'env',name:'PV1_TEST_DISPATCHER'}};config.pwceProfile={endpoint:f.base,worldRef:'world.personal.v1',executionEnvironmentRef:'live',siteRefs:['home.one'],principalRef:'agent.fixture',lifestreamEnvironmentId:randomUUID(),tokenSecretRef:'gateway',dispatcherTokenSecretRef:'dispatcher',timeoutMs:5000,maximumPromptBytes:4096};config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};const installerToken=randomUUID()+randomUUID(),password='synthetic-'+randomUUID();app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},pwceActionJournal:{create:true}});await app.start();const base='http://127.0.0.1:'+app.address().port,headers={origin:base,'content-type':'application/json'};
 const send=async(path,body,extra={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await send('/api/auth/v1/setup',{username:'synthetic-owner',password,installerToken});assert.equal(setup.status,201);headers.cookie=setup.cookie;headers['x-lifestream-csrf']=setup.body.session.csrfToken;assert.equal((await send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 const assistant=await send('/api/admin/v1/assistants',{displayName:'Synthetic review assistant'});assert.equal(assistant.status,201);const path='/api/authority/v1/assistants/'+assistant.body.assistantId+'/tools';const prepared=await send(path+'/pwce.home.light.set-level/prepare',{idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.4}}});assert.equal(prepared.status,201);const record=prepared.body.preparation;assert.equal(record.currentPreview.disposition,'approvalRequired');
 const prefix=path+'/invocations/'+record.invocationId,original={idempotencyKey:prepared.body.idempotencyKey,confirmationDigest:record.confirmationDigest};const bypass=await send(prefix+'/confirm',original);assert.ok(bypass.status>=400);assert.equal(effects,0,'no effect before approval');assert.equal((await send(prefix+'/request-approval',original,{cookie:''})).status,401,'unauthenticated request denied');assert.equal((await send(prefix+'/request-approval',original,{'x-lifestream-csrf':'invalid'})).status,403,'invalid CSRF denied');const pending=await send(prefix+'/request-approval',original);assert.equal(pending.status,200);assert.equal(pending.body.state,'pending');assert.equal(effects,0);
 assert.equal((await f.send('/api/approvals')).status,401,'Studio requires Human authentication');assert.equal((await f.login()).status,200);const list=await f.send('/api/approvals');assert.equal(list.status,200);const approval=list.body.approvals.find(a=>a.approvalRef===pending.body.approval.approvalRef);assert.ok(approval);const accepted=await f.send('/api/approvals/'+approval.approvalRef+'/approve',{confirmationDigest:approval.confirmationDigest});assert.equal(accepted.status,200);assert.equal(effects,0,'Human review itself performs no effect');
 const review=await send(prefix+'/review-approval',original);assert.equal(review.status,200);assert.equal(effects,0);const resume={...original,approvalReviewDigest:review.body.approvalReviewDigest};

 if(withdraw){
  const checksBeforeWithdrawal=targetChecks;
  f.actions.registerGrant({principalRef:'agent.fixture',siteRefs:[],capabilityRefs:[]});
  // As in the preserved regression, allow the genuine invalidation stream to settle.
  await new Promise(resolve=>setTimeout(resolve,150));
  const refused=await send(prefix+'/resume-approved',resume);
  assert.equal(refused.status,503);assert.deepEqual(refused.body,{code:'pwce_preparation_unavailable',message:'pwce preparation unavailable'});
  assert.equal(effects,0,'withdrawal must precede every target invocation');assert.equal(targetChecks,checksBeforeWithdrawal,'no fresh target check after grant withdrawal');
 }else{
  const accepted=await send(prefix+'/resume-approved',resume);assert.equal(accepted.status,200);assert.equal(accepted.body.invocation.type,'succeeded');assert.equal(effects,1);
  const repeat=await send(prefix+'/resume-approved',resume);assert.equal(repeat.status,200);assert.equal(repeat.body.invocation.type,'succeeded');assert.equal(effects,1,'same original request must not invoke twice');
 }
}
test('approved action after grant withdrawal is unavailable with zero target effects',{timeout:45000},async t=>reviewedAction(t,true));
test('current approved action still runs once and repeat keeps its original result',{timeout:45000},async t=>reviewedAction(t,false));
