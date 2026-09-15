import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionHandoffService } from "../src/endpoints/handoff.ts";

const seed = { leaseId: "lease-1", sessionId: "session-1", ownerEndpointId: "endpoint-a", revision: 1, expiresAt: "2026-09-07T00:01:00Z", fencingToken: 1 };
const request = (overrides = {}) => ({ handoffId: "handoff-1", sessionId: "session-1", sourceEndpointId: "endpoint-a", destinationEndpointId: "endpoint-b", expectedLeaseRevision: 1, initiatorRef: "human", authorized: true, destinationAvailable: true, privacyCompatible: true, occurredAt: "2026-09-07T00:00:00Z", ...overrides });

test("handoff transfers the single audio owner and fences the source", () => { const service = new SessionHandoffService(); service.seedLease(seed); const result = service.handoff(request()); assert.equal(result.outcome, "completed"); assert.equal(service.currentLease(seed.sessionId)?.ownerEndpointId, "endpoint-b"); assert.equal(service.activeOwnerCount(seed.sessionId), 1); assert.equal(result.newLease?.fencingToken, 2); assert.deepEqual(service.handoff(request()), result); });
test("failed, stale, unauthorized, or privacy-downgrade handoffs preserve the source", () => { for (const overrides of [{ expectedLeaseRevision: 2 }, { authorized: false }, { destinationAvailable: false }, { privacyCompatible: false }]) { const service = new SessionHandoffService(); service.seedLease(seed); assert.equal(service.handoff(request(overrides)).outcome, "failed"); assert.equal(service.currentLease(seed.sessionId)?.ownerEndpointId, "endpoint-a"); } });

test('output leases serialize speakers, expire, fence stale releases and preserve handoff expiry',()=>{
 const service=new SessionHandoffService(),now=Date.parse('2026-09-07T00:00:00Z'),deadline=new Date(now+60000).toISOString();
 const a=service.acquire('session','endpoint-a','first',deadline,now);assert.equal(service.owns(a,now),true);
 assert.throws(()=>service.acquire('session','endpoint-b','second',deadline,now),/already owned/u);
 const handoff=service.handoff({...request(),sessionId:'session',sourceEndpointId:'endpoint-a',destinationEndpointId:'endpoint-b',expectedLeaseRevision:a.revision});
 assert.equal(handoff.newLease!.expiresAt,deadline);assert.equal(service.owns(a,now),false);assert.equal(service.release(a),false);assert.equal(service.owns(handoff.newLease!,now),true);
 assert.equal(service.release(handoff.newLease!),true);assert.throws(()=>service.seedLease(a),/stale/u);const next=service.acquire('session','endpoint-a','third',deadline,now);assert.ok(next.fencingToken>handoff.newLease!.fencingToken);assert.equal(service.release(handoff.newLease!),false);
 assert.equal(service.owns({...next,expiresAt:new Date(now+120000).toISOString()},now+60000),false);assert.equal(service.owns(next,now+60000),false);const fresh=service.acquire('session','endpoint-b','fourth',new Date(now+120000).toISOString(),now+60000);assert.ok(fresh.fencingToken>next.fencingToken);assert.equal(service.release(next),false);assert.equal(service.owns(fresh,now+60000),true);
 for(const expires of ['invalid',new Date(now).toISOString()])assert.throws(()=>service.acquire('other','endpoint','invalid',expires,now),/invalid/u);
});

test('an expired audio lease cannot become a new handoff owner',()=>{const service=new SessionHandoffService();service.seedLease(seed);assert.equal(service.handoff(request({occurredAt:seed.expiresAt})).reason,'lease_expired');});
