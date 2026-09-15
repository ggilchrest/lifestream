import test from "node:test";
import assert from "node:assert/strict";
import { PwceScopedCache } from "../src/cache.ts";
import type { PwceInvalidationEvent } from "../src/client.ts";

const scope = () => ({ worldRef: "world.fixture", executionEnvironmentRef: "replay" as const, authorityContextRef: "authority.fixture", authorityExpiresAt: "2026-09-15T13:00:00Z", siteRef: "home.one", principalRef: "agent.one", sessionId: "session.one", environmentId: "lifestream.test", assistantRef: "assistant.one", endpointRef: "endpoint.one", participantRefs: ["participant.one"], audienceRef: "audience.one" });
function fixture(maximumAgeMs = 1000) {
  let now = Date.parse("2026-09-15T12:59:00Z"), monotonic = 100, current = true;
  const binding = scope();
  const cache = new PwceScopedCache<{ text: string }>(binding, { maximumAgeMs, isCurrent: () => current, clock: () => now, monotonic: () => monotonic });
  const read = (key = "prepared") => cache.commitRead(cache.beginRead(key), { text: "qualified value" }, { cursor: "0" });
  return { cache, binding, read, wall: (delta: number) => { now += delta; }, elapsed: (delta: number) => { monotonic += delta; }, changeOwner: () => { current = false; } };
}
function event(cursor: string, type = "context.invalidated", extra: Record<string, unknown> = {}): PwceInvalidationEvent {
  return { id: cursor, event: type, data: JSON.stringify({ eventId: `event.${cursor}`, type, cursor, sourceRevision: "revision.one", affectedRef: "home.one::sensor.one", watch: { siteRefs: ["home.one"], principalRefs: [] }, reason: "observation_accepted", occurredAt: "2026-09-15T12:59:00Z", correlationId: "correlation.one", ...extra }) };
}

test("fresh reads are isolated by immutable owner scope and returned values are copies", () => {
  const { cache, binding, read } = fixture(); binding.participantRefs.push("participant.other"); binding.audienceRef = "audience.other";
  assert.deepEqual(cache.scope.participantRefs, ["participant.one"]); assert.equal(cache.scope.audienceRef, "audience.one");
  const result = read(); result.value.text = "changed";
  assert.equal(cache.get("prepared")?.value.text, "qualified value"); assert.equal(result.isCurrent(), true);
  const other = fixture(); assert.equal(other.cache.get("prepared"), undefined);
});

test("expiry uses both wall and monotonic time and cannot be extended by clock rollback", () => {
  for (const clock of ["wall", "monotonic"] as const) {
    const f = fixture(); const lease = f.read();
    if (clock === "wall") f.wall(1001); else { f.wall(-60_000); f.elapsed(1001); }
    assert.equal(lease.isCurrent(), false); assert.equal(f.cache.get("prepared"), undefined);
  }
  const f = fixture(30_000); f.wall(59_500); const lease = f.read(); f.wall(501);
  assert.equal(lease.isCurrent(), false); assert.equal(f.cache.status().usable, false);
});

test("authority expiry and changed owner scope reject all in-flight and retained reads", () => {
  for (const change of ["expiry", "scope", "close"]) {
    const f = fixture(); const ticket = f.cache.beginRead("pending"), lease = f.read();
    if (change === "expiry") f.elapsed(60_001); else if (change === "scope") f.changeOwner(); else f.cache.close();
    assert.equal(lease.isCurrent(), false);
    assert.throws(() => f.cache.commitRead(ticket, { text: "late" }, { cursor: "0" }));
    assert.throws(() => f.cache.beginRead("new")); assert.equal(f.cache.get("prepared"), undefined);
  }
});

test("an invalidation fences late responses, while an exact duplicate does not invalidate a newer read", () => {
  const f = fixture(); const ticket = f.cache.beginRead("pending"), old = f.read();
  assert.equal(f.cache.accept(event("4")), "invalidated"); assert.equal(old.isCurrent(), false);
  assert.throws(() => f.cache.commitRead(ticket, { text: "old snapshot" }, { cursor: "4" }));
  const fresh = f.cache.commitRead(f.cache.beginRead("prepared"), { text: "fresh" }, { cursor: "4" });
  assert.equal(f.cache.accept(event("4")), "duplicate"); assert.equal(fresh.isCurrent(), true);
  assert.equal(f.cache.accept(event("9")), "invalidated", "filtered global cursor jumps are not a gap"); assert.equal(fresh.isCurrent(), false);
});

test("changed duplicate payloads, reused cursors and reordered events force resynchronization", () => {
  for (const next of [event("4", "context.invalidated", { reason: "different" }), event("4", "context.invalidated", { eventId: "other" }), event("3")]) {
    const f = fixture(); f.cache.accept(event("4"));
    const lease = f.cache.commitRead(f.cache.beginRead("prepared"), { text: "fresh" }, { cursor: "4" });
    assert.equal(f.cache.accept(next), "resync"); assert.equal(lease.isCurrent(), false); assert.equal(f.cache.status().refreshRequired, true);
  }
});

test("malformed, unscoped, unknown and oversized events cannot preserve usable context", () => {
  const frames = [
    { ...event("1"), data: "{" }, { ...event("1"), id: "2" }, event("1", "unknown"),
    event("1", "context.invalidated", { watch: { siteRefs: ["home.other"], principalRefs: [] } }),
    event("1", "context.invalidated", { occurredAt: "invalid" }),
    event("1", "context.invalidated", { reason: "x".repeat(65_536) }), event("9007199254740992")
  ];
  for (const frame of frames) { const f = fixture(); const lease = f.read(); assert.equal(f.cache.accept(frame), "resync"); assert.equal(lease.isCurrent(), false); }
});

test("control frames and disconnect invalidate reads; revoked authority cannot be refreshed", () => {
  for (const reason of ["cursor_expired", "replay_limit_exceeded", "cursor_ahead", "stream_lifetime_exceeded"]) {
    const f = fixture(), lease = f.read();
    assert.equal(f.cache.accept({ id: null, event: "resync.required", data: JSON.stringify({ reason }) }), "resync");
    assert.equal(lease.isCurrent(), false); assert.equal(f.cache.get("prepared"), undefined);
    assert.equal(f.read().isCurrent(), true);
    f.cache.disconnected(); assert.equal(f.cache.get("prepared"), undefined);
  }
  for (const reason of ["authority_context_expired", "authority_context_invalidated", "authentication_failed", "scope_denied"]) {
    const f = fixture(); const lease = f.read();
    assert.equal(f.cache.accept({ id: null, event: "resync.required", data: JSON.stringify({ reason }) }), "closed");
    assert.equal(lease.isCurrent(), false); assert.throws(() => f.read());
  }
});

test("authority changes clear every entry; capability and provider changes require new reads", () => {
  for (const kind of ["authority.invalidated", "capabilities.invalidated", "action.updated", "provider.degraded"]) {
    const f = fixture(); const a = f.read("a"), b = f.read("b");
    f.cache.accept(event("1", kind, { watch: { siteRefs: [], principalRefs: ["agent.one"] } }));
    assert.equal(a.isCurrent(), false); assert.equal(b.isCurrent(), false); assert.equal(f.cache.status().entries, 0);
    assert.equal(f.cache.status().usable, kind !== "authority.invalidated");
  }
});

test("cache count, total bytes, entry size, validity and read tickets are bounded", () => {
  const f = fixture(); const first = f.read("first"); for (let i = 0; i < 32; i++) f.read(String(i));
  assert.equal(f.cache.status().entries, 32); assert.equal(first.isCurrent(), false);
  for (let i = 0; i < 8; i++) f.cache.commitRead(f.cache.beginRead(`large.${i}`), { text: "x".repeat(240_000) }, { cursor: "0" });
  assert.ok(f.cache.status().entries <= 4);
  assert.throws(() => f.cache.commitRead(f.cache.beginRead("too-large"), { text: "x".repeat(262_144) }, { cursor: "0" }));
  assert.throws(() => f.cache.commitRead(f.cache.beginRead("expired"), { text: "old" }, { cursor: "0", validUntil: "2026-09-15T12:58:00Z" }));
  const ticket = f.cache.beginRead("one-use"); f.cache.commitRead(ticket, { text: "one" }, { cursor: "0" });
  assert.throws(() => f.cache.commitRead(ticket, { text: "two" }, { cursor: "0" }));
  const other = fixture(); assert.throws(() => other.cache.commitRead(f.cache.beginRead("foreign"), { text: "x" }, { cursor: "0" }));
});

test('bounded replay pages advance across unrelated events without invalidating fresh reads', () => {
 const f=fixture();const lease=f.read();
 assert.equal(f.cache.acceptReplay({events:[],nextCursor:'3',resyncRequired:false,hasMore:false}),false);
 assert.equal(lease.isCurrent(),true);assert.equal(f.cache.status().cursor,'3');
 assert.equal(f.cache.acceptReplay({events:[JSON.parse(event('4').data)],nextCursor:'4',resyncRequired:false,hasMore:true}),true);
 assert.equal(lease.isCurrent(),false);
 assert.equal(f.cache.acceptReplay({events:[JSON.parse(event('6').data)],nextCursor:'8',resyncRequired:false,hasMore:false}),false);
 assert.equal(f.cache.status().cursor,'8');
 const fresh=f.cache.commitRead(f.cache.beginRead('fresh'),{text:'new'},{cursor:'8'});
 const reordered=JSON.parse(event('6').data);const reversed=Object.fromEntries(Object.entries(reordered).reverse());
 assert.equal(f.cache.accept({id:'6',event:'context.invalidated',data:JSON.stringify(reversed)}),'duplicate');assert.equal(fresh.isCurrent(),true);
});

test('resynchronization accepts a reset producer cursor but preserves the fresh-read requirement', () => {
 const f=fixture();f.cache.accept(event('9'));const ticket=f.cache.beginRead('pending');
 f.cache.acceptReplay({events:[],nextCursor:'2',resyncRequired:true,hasMore:false});
 assert.equal(f.cache.status().cursor,'2');assert.equal(f.cache.status().refreshRequired,true);
 assert.throws(()=>f.cache.commitRead(ticket,{text:'old'},{cursor:'9'}));
 const fresh=f.cache.commitRead(f.cache.beginRead('new'),{text:'new'},{cursor:'2'});
 assert.equal(fresh.isCurrent(),true);
});

test('replay cannot acknowledge events it omitted, reuse a page cursor, or attach events to resync', () => {
 for(const replay of [
  {events:[JSON.parse(event('2').data)],nextCursor:'1',resyncRequired:false,hasMore:false},
  {events:[],nextCursor:'0',resyncRequired:false,hasMore:true},
  {events:[JSON.parse(event('1').data)],nextCursor:'1',resyncRequired:true,hasMore:false},
  {events:[],nextCursor:'invalid',resyncRequired:false,hasMore:false}
 ]){const f=fixture();const lease=f.read();assert.throws(()=>f.cache.acceptReplay(replay));assert.equal(lease.isCurrent(),false);}
});

test('admitted snapshot outlives cache reuse age but never evidence, authority or invalidation', () => {
 const f=fixture(), lease=f.read();f.elapsed(1001);f.wall(1001);
 assert.equal(lease.isCurrent(),false);assert.equal(lease.isSnapshotCurrent(),true);
 f.read();assert.equal(lease.isSnapshotCurrent(),true,'cache replacement alone does not revoke an admitted snapshot');
 f.cache.accept(event('1'));assert.equal(lease.isSnapshotCurrent(),false);
 for(const change of ['scope','authority','disconnect']){
  const g=fixture(), read=g.read();
  if(change==='scope')g.changeOwner();else if(change==='authority')g.elapsed(60001);else g.cache.disconnected();
  assert.equal(read.isSnapshotCurrent(),false);
 }
 const g=fixture();const bounded=g.cache.commitRead(g.cache.beginRead('bounded'),{text:'fresh'}, {cursor:'0',validUntil:'2026-09-15T12:59:02Z'});
 g.elapsed(2001);g.wall(-60000);assert.equal(bounded.isSnapshotCurrent(),false,'wall rollback cannot extend source validity');
});
