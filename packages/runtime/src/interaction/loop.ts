export type InteractionState = "received" | "running" | "completed" | "cancelled" | "failed";
export type MessageRequest = { interactionId: string; text: string; maxTokens?: number };
export type ResponseChunk = { type: "text" | "done" | "error"; text?: string };
export class InteractionLoop {
  private readonly states = new Map<string, InteractionState>();
  start(request: MessageRequest): void { if (!request.interactionId || !request.text) throw new Error("invalid message"); if (this.states.has(request.interactionId)) throw new Error("duplicate interaction"); this.states.set(request.interactionId, "running"); }
  complete(id: string): void { if (this.states.get(id) !== "running") throw new Error("invalid transition"); this.states.set(id, "completed"); }
  cancel(id: string): void { if (this.states.get(id) !== "running") throw new Error("invalid transition"); this.states.set(id, "cancelled"); }
  state(id: string): InteractionState | undefined { return this.states.get(id); }
}
