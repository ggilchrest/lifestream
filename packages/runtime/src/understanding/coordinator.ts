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
/** Explicit supervised foreground work shares latency with other foreground
 * turns. It is not P2 admission and supplies no native release qualification. */
export type SupervisedForegroundWork<T> = Pick<BackgroundWork<T>, 'key' | 'deadlineAt' | 'current' | 'admitOnce' | 'steps' | 'publish'> & {
  sharingConsentCurrent: () => boolean;
};

export const SHARED_PROVIDER_PREEMPTION_BOUND_MS = 10;
export const SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS = 250;

export class UnderstandingWorkCoordinator {
  private active: { key: string; controller: AbortController } | undefined;
  private supervised: { key: string; controller: AbortController } | undefined;
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
  cancelSupervisedForeground(key: string, reason: "explicit" | "scopeInvalidated" | "shutdown" = "explicit"): boolean {
    if (this.supervised?.key !== key) return false;
    this.supervised.controller.abort(reason); return true;
  }
  async runSupervisedForeground<T>(work: SupervisedForegroundWork<T>): Promise<BackgroundResult> {
    const stopped=(state:BackgroundResult['state'],reason:string,completedSteps=0):BackgroundResult=>({state,reason,completedSteps});
    const {key,deadlineAt,current:scopeCurrent,sharingConsentCurrent,admitOnce,publish}=work,step=work.steps[0];
    const began=this.now(),monoDeadline=performance.now()+deadlineAt-began;let lastWall=began;
    if(!key||key.length>200||work.steps.length!==1||typeof step!=='function'||!Number.isFinite(deadlineAt)||deadlineAt>began+120000||typeof sharingConsentCurrent!=='function')throw Error('Invalid bounded supervised foreground work');
    if(this.supervised)return stopped('suppressed','supervisedForegroundBusy');
    const controller=new AbortController();this.supervised={key,controller};let release:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined,completed=0;
    const current=(publicationComplete=false)=>{try{const now=this.now();if(now<lastWall)return false;lastWall=now;return this.supervised?.controller===controller&&!controller.signal.aborted&&(publicationComplete||now<deadlineAt&&performance.now()<monoDeadline)&&this.pressureAllowsWork()&&work.key===key&&work.deadlineAt===deadlineAt&&work.current===scopeCurrent&&work.sharingConsentCurrent===sharingConsentCurrent&&work.admitOnce===admitOnce&&work.publish===publish&&work.steps.length===1&&work.steps[0]===step&&sharingConsentCurrent()===true&&scopeCurrent()===true;}catch{return false;}};
    try{
      if(!current())return stopped('suppressed','supervisedConsentOrScopeUnavailable');
      if(!admitOnce())return stopped('suppressed','duplicateOrBudget');
      // Uses the SAME runtime coordinator's foreground lease. Existing P2
      // work is preempted; other foreground turns remain allowed to share.
      release=this.foregroundStarted();timer=setTimeout(()=>controller.abort('deadline'),Math.max(0,deadlineAt-this.now()));
      if(!current())return stopped('cancelled','supervisedConsentOrScopeUnavailable');
      const result=await step(controller.signal);completed=1;
      if(!current())return stopped('cancelled',controller.signal.reason==='deadline'?'deadlineExceeded':'supervisedScopeWithdrawn',completed);
      if(result===undefined||!publish(result))return stopped('cancelled','publicationConflict',completed);
      // Publication is historical once accepted before its original deadline.
      // Post-publication source/consent checks retain the original owner and
      // cancellation fences without treating the completed step as generating.
      const publishedAt=this.now();if(publishedAt<lastWall||publishedAt>=deadlineAt||performance.now()>=monoDeadline||!current(true))return stopped('cancelled','publicationConflict',completed);
      return stopped('published','publishedSupervisedForeground',completed);
    }catch{return stopped(controller.signal.aborted||!current()?'cancelled':'failed',controller.signal.reason==='deadline'?'deadlineExceeded':'supervisedWorkFailed',completed);}
    finally{if(timer)clearTimeout(timer);if(this.supervised?.controller===controller)this.supervised=undefined;if(release)release();else this.notifyIdle();}
    // An uncooperative step holds this one supervised slot until it settles;
    // cancellation/output fencing is not a claim that the native GPU is idle.
  }
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }
  canPrepareForeground(): boolean { return !this.active && !this.supervised && this.foreground === 1 && this.pressureAllowsWork(); }
  isIdle(): boolean { return !this.active && !this.supervised && this.foreground === 0 && this.pressureAllowsWork(); }
  private notifyIdle(): void {
    if (this.active || this.supervised || this.foreground !== 0) return;
    for (const listener of this.idleListeners) listener();
  }
  async run<T>(work: BackgroundWork<T>): Promise<BackgroundResult> {
    const stopped = (state: BackgroundResult["state"], reason: string, completedSteps = 0): BackgroundResult => ({ state, reason, completedSteps });
    if (!work.key || work.key.length > 200 || work.steps.length === 0 || work.steps.length > 4 || !Number.isFinite(work.deadlineAt) || work.deadlineAt > this.now() + 300000) throw new Error("invalid bounded background work");
    // Idle admission is insufficient if the next user turn could be stuck behind this call.
    if (work.sharedInference && (!Number.isFinite(work.providerPreemptionBoundMs) || work.providerPreemptionBoundMs! < 0 || work.providerPreemptionBoundMs! > SHARED_PROVIDER_PREEMPTION_BOUND_MS || !Number.isFinite(work.providerSlotReleaseBoundMs) || work.providerSlotReleaseBoundMs! < 0 || work.providerSlotReleaseBoundMs! > SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS)) return stopped("suppressed", "providerPriorityUnverified");
    if (this.active || this.supervised || this.foreground || !this.pressureAllowsWork()) return stopped("suppressed", work.priority === "P2" ? "deferredP2" : "foregroundOrCapacity");
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
