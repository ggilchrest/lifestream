export type InterruptionEvent = { kind: "noise" | "partial" | "committed"; interactionId: string };
export type InterruptionResult = "ignored" | "cancelled" | "duplicate";

export class InterruptionController {
  private active = true; private interrupted = false; private fence = 0; private readonly cancelDownstream: () => void;
  constructor(cancelDownstream: () => void) { this.cancelDownstream = cancelDownstream; }
  receive(event: InterruptionEvent): InterruptionResult { if (event.kind !== "committed") return "ignored"; if (this.interrupted) return "duplicate"; this.interrupted = true; this.active = false; this.fence += 1; this.cancelDownstream(); return "cancelled"; }
  currentFence(): number { return this.fence; }
  mayPlay(fence: number): boolean { return this.active && !this.interrupted && fence === this.fence; }
  beginNextInteraction(): number { this.interrupted = false; this.active = true; this.fence += 1; return this.fence; }
}
