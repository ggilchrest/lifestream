import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { buildCanonicalPrompt } from "@lifestream/runtime/inference/prompt";
import type { InferenceProvider } from "@lifestream/runtime/inference";

type Body = Record<string, unknown>;
const writeEvent = (response: ServerResponse, event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function streamMessage(response: ServerResponse, provider: InferenceProvider | undefined, body: Body, sessionId: string, aborted: AbortSignal): Promise<void> {
  if (!provider) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "inference_unavailable", message: "inference provider is unavailable" })); return; }
  if (typeof body.userInput !== "string" || !body.userInput.trim()) { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "invalid_request", message: "userInput is required" })); return; }
  const interactionId = randomUUID(); const assistantId = typeof body.assistantId === "string" && body.assistantId ? body.assistantId : "assistant-neutral"; const request = buildCanonicalPrompt({ assistantId, sessionId, interactionId, endpointId: typeof body.endpointId === "string" ? body.endpointId : null, userInput: body.userInput, ...(typeof body.conversation === "string" ? { conversation: body.conversation } : {}), ...(typeof body.memory === "string" ? { memory: body.memory } : {}), ...(typeof body.world === "string" ? { world: body.world } : {}), ...(typeof body.capabilities === "string" ? { capabilities: body.capabilities } : {}), executionMode: body.executionMode === "replay" ? "replay" : "live" });
  const controller = new AbortController(); const onAbort = () => controller.abort(aborted.reason); aborted.addEventListener("abort", onAbort, { once: true }); const deadline = setTimeout(() => controller.abort(new Error("deadline")), Math.max(1, Date.parse(request.deadlineAt) - Date.now()));
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" }); writeEvent(response, "interaction.started", { interactionId, sessionId, assistantId }); writeEvent(response, "input.manifest", request.manifest);
  const requestedCapability = body.readOnlyCapability && typeof body.readOnlyCapability === "object" && !Array.isArray(body.readOnlyCapability) ? body.readOnlyCapability as Record<string, unknown> : undefined;
  if (requestedCapability && typeof requestedCapability.name === "string" && requestedCapability.name && requestedCapability.input && typeof requestedCapability.input === "object" && !Array.isArray(requestedCapability.input)) writeEvent(response, "capability.read-only", { name: requestedCapability.name, input: requestedCapability.input, effect: "read-only" });
  try { for await (const chunk of provider.generate(request, { signal: controller.signal })) { if (chunk.kind === "text") writeEvent(response, "message.delta", { interactionId, text: chunk.text ?? "" }); else if (chunk.kind === "capabilityRequest") writeEvent(response, "capability.read-only", chunk.capability); else if (chunk.kind === "error") { writeEvent(response, "interaction.error", chunk.error); break; } else if (chunk.kind === "done") writeEvent(response, "interaction.completed", { interactionId }); } } finally { clearTimeout(deadline); aborted.removeEventListener("abort", onAbort); response.end(); }
}
