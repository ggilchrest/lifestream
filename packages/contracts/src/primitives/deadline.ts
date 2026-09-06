export type Deadline = {
  readonly at: number;
  remainingMs(now?: number): number;
  expired(now?: number): boolean;
};

export const createDeadline = (durationMs: number, now = Date.now()): Deadline => {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError("durationMs must be finite and non-negative");
  const at = now + durationMs;
  return {
    at,
    remainingMs: (current = Date.now()) => Math.max(0, at - current),
    expired: (current = Date.now()) => current >= at
  };
};
