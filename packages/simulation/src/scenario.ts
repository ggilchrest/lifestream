export type ScenarioStep = { at: number; actor: string; action: string; target?: string; liveEndpoint?: boolean; fault?: string };
export type ScenarioAssertion = { event: string; count?: number };
export type SimulationScenario = { id: string; environment: string; actors: string[]; steps: ScenarioStep[]; assertions: ScenarioAssertion[] };
export type ScenarioReport = { scenarioId: string; deterministic: true; events: Array<ScenarioStep & { event: string }>; passed: boolean; failures: string[] };

export class LiveScenarioError extends Error { constructor(message: string) { super(message); this.name = "LiveScenarioError"; } }

export function runScenario(scenario: SimulationScenario): ScenarioReport {
  if (scenario.steps.some((step) => step.liveEndpoint)) throw new LiveScenarioError("simulation cannot address a live endpoint");
  const actors = new Set(scenario.actors);
  const events = scenario.steps.toSorted((a, b) => a.at - b.at || a.actor.localeCompare(b.actor)).map((step) => {
    if (!actors.has(step.actor)) throw new Error(`unknown actor: ${step.actor}`);
    return { ...structuredClone(step), event: step.fault ? `fault.${step.fault}` : `${step.actor}.${step.action}` };
  });
  const failures = scenario.assertions.flatMap((assertion) => {
    const count = events.filter((event) => event.event === assertion.event).length;
    return count === (assertion.count ?? 1) ? [] : [`${assertion.event}: expected ${assertion.count ?? 1}, got ${count}`];
  });
  return { scenarioId: scenario.id, deterministic: true, events, passed: failures.length === 0, failures };
}
