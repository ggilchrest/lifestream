import assert from "node:assert/strict";
import { test } from "node:test";
import { EndpointRegistry, type EndpointProfile } from "../src/endpoints/registry.ts";

const profile = (endpointClass: EndpointProfile["endpointClass"] = "testHarness"): EndpointProfile => ({ schemaVersion: "1.0.0", endpointId: "00000000-0000-4000-8000-000000000023", endpointClass, locationRef: null, ownership: "fixture", inputModalities: ["text"], outputModalities: ["text"], privacyClass: "personal", presenceCapabilities: [], rendererCapabilities: null, handoffSupport: "none", speakerIdentity: "unavailable", health: "healthy", configurationRevision: 1 });

test("endpoint registry separates endpoint identity and uses revisioned profiles", () => { const registry = new EndpointRegistry(); assert.equal(registry.register(profile()).configurationRevision, 1); assert.equal(registry.revise(profile().endpointId, 1, { health: "degraded" }).configurationRevision, 2); assert.equal(registry.retire(profile().endpointId, 2).health, "unavailable"); assert.throws(() => registry.revise(profile().endpointId, 1, {}), /conflict/); });
test("ambient profiles declare speaker state and invalid profiles fail", () => { const registry = new EndpointRegistry(); assert.equal(registry.register(profile("ambientPresence")).speakerIdentity, "unavailable"); assert.throws(() => registry.register({ ...profile(), endpointId: "nearby-device" }), /invalid/); });
