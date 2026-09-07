export type Milestone = { name: string; clockId: string; reading: number };
export type InteractionLatencyMetrics = { ttft: number | null; ttfsw: number | null; firstSegment: number | null };

export function calculateLatency(milestones: readonly Milestone[]): InteractionLatencyMetrics {
  const clockIds = new Set(milestones.map((milestone) => milestone.clockId)); if (clockIds.size > 1) throw new Error("latency clock domain mismatch");
  const at = (name: string) => milestones.find((milestone) => milestone.name === name)?.reading ?? null;
  const delta = (start: number | null, end: number | null): number | null => start === null || end === null || end < start ? null : end - start;
  const turn = at("turn.commit"); return { ttft: delta(turn, at("inference.first-token")), ttfsw: delta(turn, at("playback.first-sample")), firstSegment: delta(turn, at("segment.first")) };
}
