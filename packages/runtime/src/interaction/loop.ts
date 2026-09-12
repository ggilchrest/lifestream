export type InteractionState = "received" | "running" | "completed" | "cancelled" | "failed";
export type MessageRequest = { interactionId: string; text: string; maxTokens?: number; origin?: "userTurn" | "relationalOpportunity" };
export type ResponseChunk = { type: "text" | "done" | "error"; text?: string };
export class InteractionLoop {
  private readonly states = new Map<string, InteractionState>();
  private readonly origins = new Map<string, MessageRequest["origin"]>();
  start(request: MessageRequest): void { const origin = request.origin ?? "userTurn"; if (!request.interactionId || (origin === "userTurn" && !request.text) || (origin === "relationalOpportunity" && request.text)) throw new Error("invalid message"); if (this.states.has(request.interactionId)) throw new Error("duplicate interaction"); this.states.set(request.interactionId, "running"); this.origins.set(request.interactionId, origin); }
  complete(id: string): void { if (this.states.get(id) !== "running") throw new Error("invalid transition"); this.states.set(id, "completed"); }
  cancel(id: string): void { if (this.states.get(id) !== "running") throw new Error("invalid transition"); this.states.set(id, "cancelled"); }
  state(id: string): InteractionState | undefined { return this.states.get(id); }
  origin(id: string): MessageRequest["origin"] | undefined { return this.origins.get(id); }
}
