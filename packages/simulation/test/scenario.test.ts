import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveScenarioError, runScenario, type SimulationScenario } from "../src/scenario.ts";

const scenario: SimulationScenario = { id: "handoff", environment: "fixture-home", actors: ["person", "assistant"], steps: [{ at: 20, actor: "assistant", action: "handoff", target: "person" }, { at: 10, actor: "person", action: "speak" }], assertions: [{ event: "person.speak" }, { event: "assistant.handoff" }] };

test("scenario runner uses virtual time and produces deterministic reports", () => {
  const first = runScenario(scenario); const second = runScenario(scenario);
  assert.deepEqual(first, second); assert.equal(first.passed, true); assert.deepEqual(first.events.map((event) => event.event), ["person.speak", "assistant.handoff"]);
});

test("scenario reports denied/fault outcomes without mutating a live system", () => {
  const report = runScenario({ ...scenario, id: "fault", steps: [{ at: 1, actor: "assistant", action: "deny", fault: "renderer" }], assertions: [{ event: "fault.renderer" }] });
  assert.equal(report.passed, true);
});

test("unknown actors and live endpoints fail closed", () => {
  assert.throws(() => runScenario({ ...scenario, steps: [{ at: 1, actor: "unknown", action: "speak" }] }), /unknown actor/);
  assert.throws(() => runScenario({ ...scenario, steps: [{ at: 1, actor: "person", action: "open", liveEndpoint: true }] }), LiveScenarioError);
});
