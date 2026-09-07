export type SkillStatus = "draft" | "active" | "retired";
export type JsonObject = { [key: string]: unknown };
export type Binding = { targetPointer: string; source: { type: "literal"; value: unknown } | { type: "input"; pointer: string } | { type: "stepOutput"; stepId: string; pointer: string } };
export type SkillStep = { stepId: string; capabilityId: string; capabilityVersion: string; inputBindings: Binding[]; onMissingInput: "reject" };
export type Skill = { schemaVersion: "1.0.0"; skillId: string; assistantId: string; revision: number; version: string; status: SkillStatus; name: string; description: string; requiredCapabilities: { capabilityId: string; version: string }[]; preconditions: ({ type: "inputPresent"; pointer: string } | { type: "inputEquals"; pointer: string; value: unknown })[]; maxSteps: number; steps: SkillStep[]; outputBindings: Binding[]; failurePolicy: "stop"; compensationGuidance: string; provenance: unknown; createdAt: string; createdBy: string; activationRef: unknown };
export type SkillInvocation = { capabilityId: string; capabilityVersion: string; input: unknown };
export type SkillInvoker = (invocation: SkillInvocation) => { lifecycle: "succeeded" | "denied" | "approvalRequired" | "failed" | "outcomeUnknown"; output?: unknown; reason?: string };
export type SkillExecutionResult = { skillId: string; skillRevision: number; executionId: string; status: "succeeded" | "failed" | "approvalRequired" | "outcomeUnknown"; completedStepIds: string[]; stoppedAtStepId: string | null; invocationIds: string[]; output: unknown; reason: string | null };
export type CapabilityProposal = { proposalId: string; assistantId: string; capabilityId: string; userValue: string; interactionRef: string; requiredData: string[]; effects: string[]; risks: string[]; candidateProviders: string[]; status: "inert" };

const forbidden = /(?:oauth|token|secret|credential|private[_-]?key|executable|dynamic\s+import)/i;

export function validateSkill(skill: Skill): void {
  if (skill.status === "active" && !skill.activationRef) throw new Error("active skill requires external activation");
  if (skill.status !== "active" && skill.activationRef !== null) throw new Error("inactive skill cannot carry activation");
  if (!Number.isInteger(skill.maxSteps) || skill.maxSteps < 1 || skill.maxSteps > 32 || skill.steps.length === 0 || skill.steps.length > skill.maxSteps) throw new Error("skill step limit invalid");
  if (skill.steps.some((step) => step.inputBindings.some((binding) => hasUnknownStepBinding(binding, skill.steps)))) throw new Error("skill binding references unknown step");
  if (forbidden.test(JSON.stringify(skill))) throw new Error("skill contains forbidden content");
}

export function createCapabilityProposal(input: Omit<CapabilityProposal, "status">): CapabilityProposal {
  if (!input.proposalId || !input.assistantId || !input.capabilityId || forbidden.test(JSON.stringify(input))) throw new Error("proposal contains forbidden content");
  return Object.freeze({ ...structuredClone(input), status: "inert" as const });
}

export class SkillExecutor {
  private readonly available: (capabilityId: string, version: string) => boolean;
  private readonly invoke: SkillInvoker;
  constructor(available: (capabilityId: string, version: string) => boolean, invoke: SkillInvoker) { this.available = available; this.invoke = invoke; }

  execute(skill: Skill, input: unknown, executionId: string): SkillExecutionResult {
    validateSkill(skill);
    if (skill.status !== "active") return this.result(skill, executionId, "failed", [], null, [], null, "skill_not_active");
    if (skill.requiredCapabilities.some((required) => !this.available(required.capabilityId, required.version))) return this.result(skill, executionId, "failed", [], null, [], null, "capability_missing");
    if (!preconditionsHold(skill.preconditions, input)) return this.result(skill, executionId, "failed", [], null, [], null, "precondition_failed");
    const outputs = new Map<string, unknown>(); const completed: string[] = []; const invocationIds: string[] = [];
    for (const step of skill.steps) {
      const args = materialize(step.inputBindings, input, outputs);
      if (!args.ok) return this.result(skill, executionId, "failed", completed, step.stepId, invocationIds, null, "input_missing");
      const invocationId = `${executionId}:${step.stepId}`; invocationIds.push(invocationId);
      const outcome = this.invoke({ capabilityId: step.capabilityId, capabilityVersion: step.capabilityVersion, input: args.value });
      if (outcome.lifecycle !== "succeeded") return this.result(skill, executionId, outcome.lifecycle === "approvalRequired" ? "approvalRequired" : outcome.lifecycle === "outcomeUnknown" ? "outcomeUnknown" : "failed", completed, step.stepId, invocationIds, null, outcome.reason ?? outcome.lifecycle);
      outputs.set(step.stepId, outcome.output); completed.push(step.stepId);
    }
    return this.result(skill, executionId, "succeeded", completed, null, invocationIds, materialize(skill.outputBindings, input, outputs).value ?? {}, null);
  }

  private result(skill: Skill, executionId: string, status: SkillExecutionResult["status"], completedStepIds: string[], stoppedAtStepId: string | null, invocationIds: string[], output: unknown, reason: string | null): SkillExecutionResult { return { skillId: skill.skillId, skillRevision: skill.revision, executionId, status, completedStepIds, stoppedAtStepId, invocationIds, output, reason }; }
}

function preconditionsHold(preconditions: Skill["preconditions"], input: unknown): boolean { return preconditions.every((condition) => condition.type === "inputPresent" ? read(input, condition.pointer) !== undefined : Object.is(read(input, condition.pointer), condition.value)); }
function hasUnknownStepBinding(binding: Binding, steps: SkillStep[]): boolean { const source = binding.source; if (source.type !== "stepOutput") return false; return !steps.some((candidate) => candidate.stepId === source.stepId); }
function materialize(bindings: Binding[], input: unknown, outputs: Map<string, unknown>): { ok: boolean; value: JsonObject } { const value: JsonObject = {}; for (const binding of bindings) { const source = readBinding(binding.source, input, outputs); if (source === undefined) return { ok: false, value }; write(value, binding.targetPointer, source); } return { ok: true, value }; }
function readBinding(source: Binding["source"], input: unknown, outputs: Map<string, unknown>): unknown { if (source.type === "literal") return source.value; if (source.type === "input") return read(input, source.pointer); return read(outputs.get(source.stepId), source.pointer); }
function read(value: unknown, pointer: string): unknown { if (pointer === "") return value; return pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).reduce<unknown>((current, part) => current !== null && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, value); }
function write(target: JsonObject, pointer: string, value: unknown): void { const parts = pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); if (parts.length === 0) throw new Error("root binding is not supported"); let current = target; for (const part of parts.slice(0, -1)) { const next = current[part]; if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {}; current = current[part] as JsonObject; } current[parts.at(-1)!] = structuredClone(value); }
