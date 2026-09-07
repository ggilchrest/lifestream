export type RendererState = {
  readonly schemaVersion: "1.0.0";
  readonly stateId: string;
  readonly sequence: number;
  readonly speechState: "silent" | "listening" | "preparing" | "speaking" | "interrupted";
  readonly activity: "idle" | "conversing" | "working" | "waiting" | "notifying" | "error";
  readonly attention: "none" | "participant" | "object" | "environment" | "task";
  readonly engagement: "idle" | "available" | "engaged" | "disengaging";
  readonly affect: { readonly valence: number; readonly arousal: number; readonly confidence: number; readonly label?: string };
  readonly urgency: "low" | "normal" | "high" | "critical";
  readonly expressionDecisionId?: string;
  readonly expressionDecisionRevision?: number;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
};

export type RendererCapabilities = {
  readonly rendererRef: string;
  readonly profileVersion: "1.0.0";
  readonly supportedAxes: readonly ["attention", "engagement", "affect", "speechState", "activity", "urgency"];
  readonly supportsExpiry: true;
  readonly supportsPatches: false;
  readonly readiness: "ready" | "degraded" | "unavailable";
};

export type RendererApplyData = {
  readonly stateId: string;
  readonly sequence: number;
  readonly disposition: "applied" | "degraded" | "rejected";
  readonly degradedAxes: readonly string[];
  readonly appliedAt: string | null;
  readonly reason: string | null;
};

export class FixtureRendererProvider {
  private lastState: RendererState | undefined;
  private readonly crashOnApply: boolean;
  readonly rendererCapabilities: RendererCapabilities;

  constructor(options: { rendererRef?: string; crashOnApply?: boolean } = {}) {
    this.crashOnApply = options.crashOnApply ?? false;
    this.rendererCapabilities = {
      rendererRef: options.rendererRef ?? "fixture-renderer",
      profileVersion: "1.0.0",
      supportedAxes: ["attention", "engagement", "affect", "speechState", "activity", "urgency"],
      supportsExpiry: true,
      supportsPatches: false,
      readiness: this.crashOnApply ? "degraded" : "ready",
    };
  }

  getCapabilities(): RendererCapabilities { return structuredClone(this.rendererCapabilities); }

  apply(state: RendererState, now: string): RendererApplyData {
    if (this.crashOnApply) return this.rejected(state, "renderer_fault");
    if (this.lastState && state.sequence <= this.lastState.sequence) return this.rejected(state, "stale_sequence");
    if (state.expiresAt && state.expiresAt <= now) return this.rejected(state, "expired_state");
    this.lastState = structuredClone(state);
    return { stateId: state.stateId, sequence: state.sequence, disposition: "applied", degradedAxes: [], appliedAt: now, reason: null };
  }

  current(): RendererState | undefined { return this.lastState && structuredClone(this.lastState); }

  private rejected(state: RendererState, reason: string): RendererApplyData {
    return { stateId: state.stateId, sequence: state.sequence, disposition: "rejected", degradedAxes: [], appliedAt: null, reason };
  }
}
