import assert from "node:assert/strict"; import { test } from "node:test"; import { EXPECTED_PWCE_ARTIFACTS, EXPECTED_PWCE_GENERATED_CLIENT_SHA256, PwceGatewayClient } from "../src/client.ts";
import type { PwceSubscriptionScope } from "../src/client.ts";
const token = process.env.PWCE_GATEWAY_TOKEN ?? "fixture-gateway-token"; const baseUrl = process.env.PWCE_GATEWAY_URL ?? "http://fixture"; const operations = ["context.getPreparedInputs", "context.query", "evidence.get", "events.subscribe", "authority.evaluate", "authority.authorizeDispatch", "authority.getGrants", "capabilities.getSnapshot", "capabilities.invoke", "capabilities.getInvocation", "trace.publish", "health.get"]; const profile = { profileId: "pwce-agent-gateway.v1", profileVersion: "1.0.0", bundleId: "pwce-agent-gateway.bundle.v1", bundleVersion: "1.0.0", schemaStatus: "published", schemaDigest: "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2", operationCatalogVersion: "0.1.0", operationCatalogDigest: "445cb4e4b9811a26a41c5821c7d68b09f377b69d24d42ec6dcd0acec5d950b65", operationCatalog: operations.map((operation) => ({ operation })) };
const bundle = { bundleId: profile.bundleId, bundleVersion: profile.bundleVersion, bundleDigest: profile.schemaDigest, artifacts: EXPECTED_PWCE_ARTIFACTS, generatedClient: { path: "src/gateway/generated-client.js", sha256: EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } };
test("verifies the exact published bundle and generated-client identity", async () => { const client = new PwceGatewayClient({ baseUrl, token, ...(process.env.PWCE_GATEWAY_URL ? {} : { fetchImpl: async () => new Response(JSON.stringify(bundle), { status: 200 }) }) }); const received = await client.bundle(); assert.equal(received.bundleDigest, profile.schemaDigest); assert.equal(received.generatedClient.sha256, EXPECTED_PWCE_GENERATED_CLIENT_SHA256); });
test("rejects a drifted generated-client identity", async () => { const client = new PwceGatewayClient({ baseUrl: "http://fixture", token, fetchImpl: async () => new Response(JSON.stringify({ ...bundle, generatedClient: { ...bundle.generatedClient, sha256: "wrong" } }), { status: 200 }) }); await assert.rejects(() => client.bundle(), /bundle is incompatible/); });
test("rejects a drifted artifact identity", async () => { const client = new PwceGatewayClient({ baseUrl: "http://fixture", token, fetchImpl: async () => new Response(JSON.stringify({ ...bundle, artifacts: [{ ...bundle.artifacts[0], sha256: "wrong" }, ...bundle.artifacts.slice(1)] }), { status: 200 }) }); await assert.rejects(() => client.bundle(), /bundle is incompatible/); });
test("negotiates the pinned PWCE profile and bundle before every gateway operation", async () => { let call = 0; const fetchImpl = process.env.PWCE_GATEWAY_URL ? undefined : async (url) => { call += 1; const value = url.endsWith("profile") ? profile : url.endsWith("bundle") ? bundle : url.endsWith("authority") ? { authorityContextRef: "authority.fixture" } : { profileId: "pwce-agent-gateway.v1", status: "known" }; return new Response(JSON.stringify(value), { status: 200 }); }; const client = new PwceGatewayClient({ baseUrl, token, ...(fetchImpl ? { fetchImpl } : {}) }); const receivedProfile = await client.profile(); assert.equal(receivedProfile.profileVersion, "1.0.0"); const authority = await client.authority(["home.one"]); assert.equal(typeof authority.authorityContextRef, "string"); const health = await client.health(String(authority.authorityContextRef)); assert.equal(health.profileId, "pwce-agent-gateway.v1"); const prepared = await client.getPreparedInputs(String(authority.authorityContextRef), "home.one"); assert.equal(prepared.profileId, "pwce-agent-gateway.v1"); if (!process.env.PWCE_GATEWAY_URL) assert.equal(call, 10); });
test("fails closed before an operation when bundle identity drifts", async () => { const paths: string[] = []; const client = new PwceGatewayClient({ baseUrl: "http://fixture", token, fetchImpl: async (url) => { paths.push(url); return new Response(JSON.stringify(url.endsWith("profile") ? profile : { ...bundle, generatedClient: { ...bundle.generatedClient, sha256: "wrong" } }), { status: 200 }); } }); await assert.rejects(() => client.health("authority.fixture"), /bundle is incompatible/); assert.equal(paths.some((path) => path.endsWith("/gateway/v1/request")), false); });
test("fails closed on an incompatible profile before any request is sent", async () => { let calls = 0; const client = new PwceGatewayClient({ baseUrl: "http://fixture", token, fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ ...profile, profileVersion: "2.0.0", schemaDigest: "wrong" }), { status: 200 }); } }); await assert.rejects(() => client.profile(), /incompatible/); assert.equal(calls, 1); });
test("does not allow an unadvertised operation", async () => { const client = new PwceGatewayClient({ baseUrl: "http://fixture", token, fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith("profile") ? { ...profile, operationCatalog: [{ operation: "health.get" }] } : url.endsWith("bundle") ? bundle : {}), { status: 200 }) }); await assert.rejects(() => client.request({ operation: "admin.install" }), /not advertised/); });
test("exposes the complete mapped core operation surface", async () => { const requests: string[] = []; const client = new PwceGatewayClient({ baseUrl, token, fetchImpl: async (url, init) => { requests.push(`${init?.method ?? "GET"} ${url}`); if (url.endsWith("profile")) return new Response(JSON.stringify(profile), { status: 200 }); if (url.endsWith("bundle")) return new Response(JSON.stringify(bundle), { status: 200 }); return new Response(JSON.stringify({ status: "known", operation: JSON.parse(String(init?.body)).operation }), { status: 200 }); } }); const authority = "authority.fixture"; await client.queryContext(authority, { mode: "search", siteRefs: ["home.one"], text: "x" }); await client.getEvidence(authority, "evidence.fixture"); await client.getGrants(authority); await client.evaluate(authority, { capabilityRef: "capability.fixture" }); await client.authorizeDispatch(authority, { capabilityRef: "capability.fixture" }); await client.getCapabilities(authority); await client.invoke(authority, { capabilityRef: "capability.fixture", idempotencyKey: "idempotency.fixture" }); await client.getInvocation(authority, "action.fixture"); await client.publishTrace(authority, { traceNamespace: "lifestream.fixture", events: [{ type: "fixture" }] }); assert.deepEqual(requests.filter((request) => request.includes("/gateway/v1/request")).length, 9); });
test("parses the PWCE bounded SSE invalidation stream", async () => { const sse = "id: 7\nevent: context.invalidated\ndata: {\"cursor\":\"7\"}\n\n: gateway-replay\n\nevent: resync.required\ndata: {\"reason\":\"cursor_expired\"}\n\n"; const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close(); } }); const client = new PwceGatewayClient({ baseUrl, token, fetchImpl: async (url) => { if (url.endsWith("profile")) return new Response(JSON.stringify(profile), { status: 200 }); if (url.endsWith("bundle")) return new Response(JSON.stringify(bundle), { status: 200 }); return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }); } }); const events = []; for await (const event of client.subscribeInvalidations("authority.fixture", "home.one")) events.push(event); assert.deepEqual(events, [{ id: "7", event: "context.invalidated", data: "{\"cursor\":\"7\"}" }, { id: null, event: "resync.required", data: "{\"reason\":\"cursor_expired\"}" }]); });

test('operation-specific methods reject caller replacement of operation, authority and transport credentials before networking',async()=>{
 let calls=0;const client=new PwceGatewayClient({baseUrl:'http://fixture',token:'synthetic-client-token',fetchImpl:async()=>{calls++;throw new Error('No request should be sent');}});
 for(const method of ['queryContext','evaluate','authorizeDispatch','invoke','publishTrace'] as const){
  for(const field of ['operation','authorityContextRef','token'])await assert.rejects(()=>client[method]('authority.bound',{[field]:'forged'}),/cannot replace/);
  await assert.rejects(()=>client[method]('',{}),/authority reference/);
 }
 await assert.rejects(()=>client.request({operation:'health.get',authorityContextRef:'authority.bound',token:'forged'}),/transport credentials/);
 await assert.rejects(()=>client.request({operation:['health.get'],authorityContextRef:'authority.bound'}),/not advertised/);
 assert.equal(calls,0);
});

test('required core catalog gaps and duplicates fail before otherwise advertised operations',async()=>{
 for(const catalog of [profile.operationCatalog.slice(1),[...profile.operationCatalog.slice(1),profile.operationCatalog[1]], [...profile.operationCatalog,{operation:'admin.install'}]]){
  const paths:string[]=[];const client=new PwceGatewayClient({baseUrl:'http://fixture',token:'synthetic-client-token',fetchImpl:async(url)=>{paths.push(String(url));return new Response(JSON.stringify(String(url).endsWith('profile')?{...profile,operationCatalog:catalog}:bundle));}});
  await assert.rejects(()=>client.health('authority.bound'),/required core operation catalog/);
  assert.equal(paths.some(path=>path.endsWith('/gateway/v1/request')),false);
 }
});

test('request and wrapper inputs are snapshotted before asynchronous profile negotiation',async()=>{
 for(const mode of ['request','query','authority']){
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let observed:any;
  const client=new PwceGatewayClient({baseUrl:'http://fixture',token:'synthetic-client-token',fetchImpl:async(url,init)=>{
   if(String(url).endsWith('profile')){await wait;return new Response(JSON.stringify(profile));}
   if(String(url).endsWith('bundle'))return new Response(JSON.stringify(bundle));
   observed=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'known'}));
  }});
  const wrapped=mode!=='request';const input:any=wrapped?{mode:'search',siteRefs:['home.one']}:{operation:'health.get',authorityContextRef:'authority.bound',siteRefs:['home.one']};
  const pending=mode==='authority'?client.authority(input.siteRefs):wrapped?client.queryContext('authority.bound',input):client.request(input);
  input.operation='capabilities.invoke';input.authorityContextRef='authority.other';input.siteRefs.push('home.other');release();await pending;
  assert.equal(observed.operation,mode==='authority'?undefined:wrapped?'context.query':'health.get');assert.equal(observed.authorityContextRef,mode==='authority'?undefined:'authority.bound');assert.deepEqual(observed.siteRefs,['home.one']);
 }
});

test('scoped authority and SSE preserve host identities and snapshot before iteration', async () => {
 const seen: {url:string;body?:string}[]=[];
 const client=new PwceGatewayClient({baseUrl:'http://fixture',token:'synthetic-client-token',fetchImpl:async(url,init)=>{
  seen.push({url:String(url),body:typeof init?.body==='string'?init.body:undefined});
  if(String(url).includes('/events?'))return new Response('event: resync.required\ndata: {"reason":"authority_context_expired"}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  return new Response(JSON.stringify(String(url).endsWith('profile')?profile:String(url).endsWith('bundle')?bundle:{status:'known'}));
 }});
 const identity={assistantRef:'assistant.one',endpointRef:'endpoint.one',participantRefs:['participant.one'],audienceRef:'audience.one'};
 const pending=client.authority(['home.one'],undefined,identity);identity.participantRefs.push('participant.other');await pending;
 assert.deepEqual(JSON.parse(seen.find(item=>item.url.endsWith('/authority'))!.body!).participantRefs,['participant.one']);
 const scope:PwceSubscriptionScope={...identity,worldRef:'world.personal.v1',executionEnvironmentRef:'replay',requestId:'request.one',correlationId:'correlation.one'};
 const stream=client.subscribeInvalidations('authority.bound','home.one',{scope});
 identity.participantRefs.push('participant.late');(scope as any).worldRef='world.other';
 const events=[];for await(const event of stream)events.push(event);
 const params=new URL(seen.find(item=>item.url.includes('/events?'))!.url).searchParams;
 assert.equal(params.get('worldRef'),'world.personal.v1');assert.equal(params.get('executionEnvironmentRef'),'replay');
 assert.equal(params.get('authorityContextRef'),'authority.bound');assert.equal(params.get('siteRef'),'home.one');
 assert.deepEqual(JSON.parse(params.get('participantRefs')!),['participant.one','participant.other']);
 assert.equal(params.get('assistantRef'),'assistant.one');assert.equal(params.get('audienceRef'),'audience.one');
 assert.equal(events[0].event,'resync.required');
});

test('scoped subscriptions reject scope overrides and malformed identities before network', async () => {
 let calls=0;
 const client=new PwceGatewayClient({baseUrl:'http://fixture',token:'synthetic-client-token',fetchImpl:async()=>{calls++;throw new Error('network forbidden');}});
 const scope:PwceSubscriptionScope={worldRef:'world.personal.v1',executionEnvironmentRef:'test',requestId:'request.one',correlationId:'correlation.one'};
 for(const change of [{operation:'capabilities.invoke'},{token:'other'},{siteRef:'other'},{authorityContextRef:'other'},{worldRef:''},{requestId:undefined},{executionEnvironmentRef:'other'},{participantRefs:['p','p']},{participantRefs:'p'},{audienceRef:123}])assert.throws(()=>client.subscribeInvalidations('authority.bound','home.one',{scope:{...scope,...change} as any}));
 for(const afterCursor of ['','1e2','-1','9007199254740992',0 as any])assert.throws(()=>client.subscribeInvalidations('authority.bound','home.one',{afterCursor}));
 await assert.rejects(client.authority(['home.one'],undefined,{siteRefs:['home.other']} as any));
 assert.equal(calls,0);
});
