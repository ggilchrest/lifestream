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
  providerSlotReleaseBoundMs?: number;
  priority?: "P0" | "P1" | "P2";
};
export type BackgroundResult = { state: "published" | "suppressed" | "cancelled" | "failed"; reason: string; completedSteps: number };

export const SHARED_PROVIDER_PREEMPTION_BOUND_MS = 10;
export const SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS = 250;

export class UnderstandingWorkCoordinator {
  private active: { key: string; controller: AbortController } | undefined;
  private foreground = 0;
  private readonly idleListeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly pressureAllowsWork: () => boolean;
  constructor(options: { now?: () => number; pressureAllowsWork: () => boolean }) {
    this.now = options.now ?? Date.now;
    this.pressureAllowsWork = options.pressureAllowsWork;
  }
  foregroundStarted(): () => void {
    this.foreground++;
    this.active?.controller.abort("foreground");
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.foreground--;
        this.notifyIdle();
      }
    };
  }
  cancel(key: string, reason: "explicit" | "scopeInvalidated" | "shutdown" = "explicit"): boolean {
    if (this.active?.key !== key) return false;
    this.active.controller.abort(reason); return true;
  }
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }
  isIdle(): boolean { return !this.active && this.foreground === 0 && this.pressureAllowsWork(); }
  private notifyIdle(): void {
    if (this.active || this.foreground !== 0) return;
    for (const listener of this.idleListeners) listener();
  }
  async run<T>(work: BackgroundWork<T>): Promise<BackgroundResult> {
    const stopped = (state: BackgroundResult["state"], reason: string, completedSteps = 0): BackgroundResult => ({ state, reason, completedSteps });
    if (!work.key || work.key.length > 200 || work.steps.length === 0 || work.steps.length > 4 || !Number.isFinite(work.deadlineAt) || work.deadlineAt > this.now() + 300000) throw new Error("invalid bounded background work");
    // Idle admission is insufficient if the next user turn could be stuck behind this call.
    if (work.sharedInference && (!Number.isFinite(work.providerPreemptionBoundMs) || work.providerPreemptionBoundMs! < 0 || work.providerPreemptionBoundMs! > SHARED_PROVIDER_PREEMPTION_BOUND_MS || !Number.isFinite(work.providerSlotReleaseBoundMs) || work.providerSlotReleaseBoundMs! < 0 || work.providerSlotReleaseBoundMs! > SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS)) return stopped("suppressed", "providerPriorityUnverified");
    if (this.active || this.foreground || !this.pressureAllowsWork()) return stopped("suppressed", work.priority === "P2" ? "deferredP2" : "foregroundOrCapacity");
    if (this.now() >= work.deadlineAt || !work.current()) return stopped("suppressed", "staleBoundary");
    const controller = new AbortController(); this.active = { key: work.key, controller };
    let timer: ReturnType<typeof setTimeout> | undefined, completed = 0;
    const current = () => !controller.signal.aborted && !this.foreground && this.pressureAllowsWork() && this.now() < work.deadlineAt && work.current();
    try {
      // A failed or duplicate admission remains charged or rejected by the owner;
      // only a safe preemption can return work to an idle retry queue.
      if (!work.admitOnce()) return stopped("suppressed", "duplicateOrBudget");
      timer = setTimeout(() => controller.abort("deadline"), Math.max(0, work.deadlineAt - this.now()));
      let result: T | undefined;
      for (const step of work.steps) {
        if (!current()) return stopped("cancelled", this.stopReason(controller, work), completed);
        result = await step(controller.signal);
        completed++;
        if (!current()) return stopped("cancelled", this.stopReason(controller, work), completed);
        // Yield between bounded host-owned stages; source/provider ports enforce their own limits.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (!current()) return stopped("cancelled", this.stopReason(controller, work), completed);
      if (result === undefined || !work.publish(result)) return stopped("cancelled", "publicationConflict", completed);
      return stopped("published", "publishedCurrentRevision", completed);
    } catch {
      let cancelled=controller.signal.aborted;
      try{cancelled ||= !current();}catch{cancelled=true;}
      return stopped(cancelled ? "cancelled" : "failed", cancelled ? this.stopReason(controller, work) : "workFailed", completed);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // An uncooperative port keeps the single slot occupied until it settles, preventing fan-out.
      if (this.active?.controller === controller) this.active = undefined;
      this.notifyIdle();
    }
  }
  private stopReason<T>(controller: AbortController, work: BackgroundWork<T>): string {
    const signalReason = controller.signal.reason;
    if (signalReason === "foreground") return "foregroundPreempted";
    if (signalReason === "explicit") return "explicitCancelled";
    if (signalReason === "scopeInvalidated") return "scopeInvalidated";
    if (signalReason === "shutdown") return "runtimeClosed";
    if (signalReason === "deadline") return "deadlineExceeded";
    if (!work.current()) return "staleBoundary";
    if (!this.pressureAllowsWork()) return "capacityPressure";
    return "cancelled";
  }
}
