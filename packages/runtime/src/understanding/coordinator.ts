/** Bounded work inside the existing runtime. Host ports own authority, durable admission and publication. */
export type BackgroundWork<T> = {
  key: string;
  deadlineAt: number;
  current: () => boolean;
  admitOnce: () => boolean;
  steps: readonly ((signal: AbortSignal) => Promise<T>)[];
  publish: (value: T) => boolean;
  sharedInference: boolean;
  providerPreemptionBoundMs?: number;
};
export type BackgroundResult = { state: "published" | "suppressed" | "cancelled" | "failed"; reason: string; completedSteps: number };

export class UnderstandingWorkCoordinator {
  private active: { key: string; controller: AbortController } | undefined;
  private foreground = 0;
  private readonly now: () => number;
  private readonly pressureAllowsWork: () => boolean;
  constructor(options: { now?: () => number; pressureAllowsWork: () => boolean }) {
    this.now = options.now ?? Date.now;
    this.pressureAllowsWork = options.pressureAllowsWork;
  }
  foregroundStarted(): () => void {
    this.foreground++;
    this.active?.controller.abort();
    let released = false;
    return () => { if (!released) { released = true; this.foreground--; } };
  }
  cancel(key: string): boolean {
    if (this.active?.key !== key) return false;
    this.active.controller.abort(); return true;
  }
  async run<T>(work: BackgroundWork<T>): Promise<BackgroundResult> {
    const stopped = (state: BackgroundResult["state"], reason: string, completedSteps = 0): BackgroundResult => ({ state, reason, completedSteps });
    if (!work.key || work.key.length > 200 || work.steps.length === 0 || work.steps.length > 4 || !Number.isFinite(work.deadlineAt) || work.deadlineAt > this.now() + 300000) throw new Error("invalid bounded background work");
    // Idle admission is insufficient if the next user turn could be stuck behind this call.
    if (work.sharedInference && (!Number.isFinite(work.providerPreemptionBoundMs) || work.providerPreemptionBoundMs! < 0 || work.providerPreemptionBoundMs! > 10)) return stopped("suppressed", "providerPriorityUnverified");
    if (this.active || this.foreground || !this.pressureAllowsWork()) return stopped("suppressed", "foregroundOrCapacity");
    if (this.now() >= work.deadlineAt || !work.current()) return stopped("suppressed", "staleBoundary");
    const controller = new AbortController(); this.active = { key: work.key, controller };
    let timer: ReturnType<typeof setTimeout> | undefined, completed = 0;
    try {
      // A failed/duplicate admission remains charged or rejected by the owner; no automatic retry.
      if (!work.admitOnce()) return stopped("suppressed", "duplicateOrBudget");
      timer = setTimeout(() => controller.abort(), Math.max(0, work.deadlineAt - this.now()));
      const current = () => !controller.signal.aborted && !this.foreground && this.pressureAllowsWork() && this.now() < work.deadlineAt && work.current();
      let result: T | undefined;
      for (const step of work.steps) {
        if (!current()) return stopped("cancelled", "currentBoundaryDenied", completed);
        result = await step(controller.signal);
        completed++;
        if (!current()) return stopped("cancelled", "currentBoundaryDenied", completed);
        // Yield between bounded host-owned stages; source/provider ports enforce their own limits.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (!current()) return stopped("cancelled", "currentBoundaryDenied", completed);
      if (result === undefined || !work.publish(result)) return stopped("cancelled", "publicationConflict", completed);
      return stopped("published", "publishedCurrentRevision", completed);
    } catch {
      return stopped(controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted ? "cancelled" : "workFailed", completed);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // An uncooperative port keeps the single slot occupied until it settles, preventing fan-out.
      if (this.active?.controller === controller) this.active = undefined;
    }
  }
}
