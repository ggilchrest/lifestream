import { createHash } from "node:crypto";
import type { InferenceRequest, InferenceSection, InputManifest } from "./port.js";

const kinds = ["policy", "corePersona", "adaptivePersona", "interactionState", "preparedMemory", "worldContext", "capabilityState", "conversation", "userInput"] as const;
const digest = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const tokens = (content: string) => content.trim() ? content.trim().split(/\s+/u).length : 0;

export type PromptInput = { assistantId: string; sessionId: string; interactionId: string; endpointId: string | null; userInput: string; conversation?: string; memory?: string; world?: string; capabilities?: string; deadlineAt?: string; executionMode?: "live" | "replay"; voiceMode?: boolean };

const voicePolicy = " Respond for spoken conversation. Start with a concise complete sentence that addresses the request. Use natural plain language, without emoji, markdown decoration, headings, tables, code fences, internal control tags or stage directions in speech. Ordinary replies should usually be one to three sentences; honor requests for detail. Present complex code, commands, links and tables visually with an accurate brief spoken explanation. Preserve uncertainty; never claim actions or lookups that have not occurred.";

export function buildCanonicalPrompt(input: PromptInput): InferenceRequest {
  const values = [
    ["policy", "Follow the Assistant contract. Never claim an effect without a governed result." + (input.voiceMode ? voicePolicy : ""), true, input.voiceMode ? "policy:spoken-v1" : "policy:v1"],
    ["corePersona", "A user-authored Assistant with provider-neutral identity and bounded behavior.", true, "assistant-profile:generic-v1"],
    ["adaptivePersona", "No adaptive changes are active for this interaction.", true, "adaptive-policy:v1"],
    ["interactionState", `assistant=${input.assistantId};session=${input.sessionId};interaction=${input.interactionId};endpoint=${input.endpointId ?? "none"}`, true, "interaction-scope:v1"],
    ["preparedMemory", input.memory ?? "No prepared memory is available.", false, "memory:prepared-v1"],
    ["worldContext", input.world ?? "No world context is available.", false, "world:prepared-v1"],
    ["capabilityState", input.capabilities ?? "Only bounded read-only capability selection is available.", false, "capability:snapshot-v1"],
    ["conversation", input.conversation ?? "No prior conversation turns are supplied.", false, "conversation:session-v1"],
    ["userInput", input.userInput, false, "user-input:current-v1"]
  ] as const;
  const sections: InferenceSection[] = values.map(([kind, content, trusted, sourceRef]) => ({ kind, content, trusted, sourceRevision: "v1", sourceRef, contentDigest: digest(content), redaction: "none", tokenCount: tokens(content) }));
  if (sections.map((section) => section.kind).join(",") !== kinds.join(",")) throw new Error("canonical prompt section order mismatch");
  const manifest: InputManifest = { schemaVersion: "1.0.0", sections: sections.map(({ kind, sourceRevision, sourceRef, contentDigest, redaction, tokenCount }) => ({ kind, sourceRevision, sourceRef, contentDigest, redaction, tokenCount })), tokenizer: "whitespace-v1" };
  return { sections, manifest, deadlineAt: input.deadlineAt ?? new Date(Date.now() + 10_000).toISOString(), executionMode: input.executionMode ?? "live", scope: { assistantId: input.assistantId, sessionId: input.sessionId, interactionId: input.interactionId, endpointId: input.endpointId } };
}
