import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
/** The owner configures this adapter, never the candidate or retrieved evidence. */
export type WorkshopRepository = {
  id: string;
  rootPath: string;
  /** Exact repository-relative paths. No globs, directories, private files or symlinks. */
  allowedPaths: string[];
  readPaths?: string[];
  protectedPaths?: string[];
  /** Trusted, independent Node scripts outside the repository. All checks are mandatory. */
  acceptanceChecks: {id: string; scriptPath: string}[];
};
export type WorkshopChange = {path: string; expectedContentHash: string | null; content: string | null};
export type WorkshopPrepare = {improvementId: string; repositoryId: string; changes: WorkshopChange[]; baseRevision?: string};
export type WorkshopExecution = {signal?: AbortSignal; maximumDurationMs?: number};
export type WorkshopPlanningContext = {
  repositoryId: string; baseRevision: string;
  files: {path: string; content: string; sha256: string; editable: boolean}[];
  acceptanceChecks: string[];
};
export type WorkshopAction = 'prepare' | 'apply' | 'rollback';
export type WorkshopAuthority = {
  improvementId: string; repositoryId: string; candidateId: string; outcomeDigest: string;
  baseRevision: string; candidateRevision: string | null; paths: string[];
};
export type WorkshopCheckResult = {
  id: string; scriptDigest: string; passed: boolean; exitCode: number | null;
  reason: 'completed' | 'timeout' | 'outputLimit' | 'unavailable' | 'cancelled'; durationMs: number; output: string;
};
export type WorkshopCandidateSummary = {
  id: string; improvementId: string; repositoryId: string; baseRevision: string;
  candidateRevision: string | null; outcomeDigest: string; passed: boolean;
  state: 'preparing' | 'readyForReview' | 'failed' | 'applying' | 'applied' | 'reverting' | 'reverted';
  branch: string; baseline: WorkshopCheckResult[]; evaluation: WorkshopCheckResult[];
  changedPaths: string[]; attempts: number; createdAt: string; updatedAt: string;
  application: {path: string; decisionId: string; revision: string; checkpoint: 'initializing' | 'applying' | 'applied' | 'reverting' | 'reverted'} | null;
  error: string | null;
};
export type WorkshopCandidateReview = {candidate: WorkshopCandidateSummary; changes: {path: string; before: string | null; after: string | null}[]};
type CandidateRecord = WorkshopCandidateSummary & {requestDigest: string; policyDigest: string; changes: WorkshopChange[]};
export type ImprovementWorkshopOptions = {
  stateDirectory: string; repositories: WorkshopRepository[];
  /** Must read current persisted authority; absence or silence is never a grant. */
  authorize: (candidate: WorkshopAuthority, action: WorkshopAction, decisionId?: string) => boolean | Promise<boolean>;
  nodeExecutable?: string;
  limits?: Partial<{timeoutMs: number; outputBytes: number; workspaceBytes: number; patchBytes: number; maximumCandidates: number; scratchBytes: number}>;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const workshopContentHash = (value: string) => hash(value);
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
const safeId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const safePath = (value: string) => value.length > 0 && value.length < 512 && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(p => p.length > 0 && p !== '.' && p !== '..' && !p.startsWith('.')) && !/[\x00-\x1f*?\[\]:]/.test(value);
const protectedAuthorityPaths = ['packages/runtime/src/understanding/coordinator.ts', 'packages/runtime/src/understanding/resources.ts', 'apps/server/src/admin/understanding.ts', 'apps/server/src/index.ts', 'scripts/start-candidate.mjs'];
const protectedPath = (value: string) => /(^|\/)(?:auth(?:ority|entication|orization)?|permissions?|credentials?|secrets?|mandates?)(?:[./_-]|$)/i.test(value) || /(?:improvement-workshop|autonomy|resource-(?:balanc|schedul)|config\/(?:loader|schema))/i.test(value) || /\.(?:pem|key|sqlite|db)$/i.test(value) || protectedAuthorityPaths.some(path => value === path || value.endsWith('/' + path));
const summary = (record: CandidateRecord): WorkshopCandidateSummary => {
  const {requestDigest: _request, policyDigest: _policy, changes: _changes, ...result} = structuredClone(record);
  return result;
};

export type ReadonlyWorkshopOptions=Omit<ImprovementWorkshopOptions,'authorize'>;
/** Original S104 captured-baseline review only. No process runner, writes,
 * locks, recovery, source checkout, preparation or application capability. */
export class ImprovementWorkshop {
  private readonly options:ReadonlyWorkshopOptions;
  private readonly limits:{timeoutMs:number;outputBytes:number;workspaceBytes:number;patchBytes:number;maximumCandidates:number;scratchBytes:number};
  constructor(options: ReadonlyWorkshopOptions) {
    this.options = {...options, repositories: structuredClone(options.repositories), stateDirectory: resolve(options.stateDirectory)};
    this.limits = {timeoutMs: 15_000, outputBytes: 64 * 1024, workspaceBytes: 64 * 1024 * 1024,
      patchBytes: 512 * 1024, maximumCandidates: 32, scratchBytes: 8 * 1024 * 1024, ...options.limits};
    const ceilings = {timeoutMs: 120_000, outputBytes: 1024 * 1024, workspaceBytes: 256 * 1024 * 1024,
      patchBytes: 2 * 1024 * 1024, maximumCandidates: 128, scratchBytes: 64 * 1024 * 1024};
    for (const name of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] <= 0 || this.limits[name] > ceilings[name]) throw new Error(`Invalid workshop ${name} limit`);
    }
    if (new Set(options.repositories.map(r => r.id)).size !== options.repositories.length) throw new Error('Duplicate workshop repository');
    for (const repo of this.options.repositories) {
      repo.rootPath = resolve(repo.rootPath);
      if (!safeId(repo.id) || within(repo.rootPath, this.options.stateDirectory) || within(this.options.stateDirectory, repo.rootPath)) throw new Error('Workshop state must be outside source repositories');
      if (!repo.allowedPaths.length || repo.allowedPaths.length > 64 || (repo.readPaths?.length ?? 0) > 128 || [...repo.allowedPaths, ...(repo.readPaths ?? [])].some(p => !safePath(p) || protectedPath(p))) throw new Error('Unsafe workshop path allowlist');
      if (!repo.acceptanceChecks.length || repo.acceptanceChecks.length > 16 || new Set(repo.acceptanceChecks.map(c => c.id)).size !== repo.acceptanceChecks.length) throw new Error('Independent acceptance checks are required');
      for (const check of repo.acceptanceChecks) if (!safeId(check.id) || !isAbsolute(check.scriptPath) || within(repo.rootPath, resolve(check.scriptPath)) || within(this.options.stateDirectory, resolve(check.scriptPath))) throw new Error('Acceptance checks must be independent of source and workshop state');
    }
  }


  private async initialize(){
    if(await realpath(this.options.stateDirectory)!==this.options.stateDirectory)throw Error('Unsafe workshop state');
    for(const name of ['records','worktrees'])if(await realpath(join(this.options.stateDirectory,name))!==join(this.options.stateDirectory,name))throw Error('Unsafe workshop state');
    for(const repo of this.options.repositories)if(await realpath(repo.rootPath)!==repo.rootPath)throw Error('Unsafe workshop repository');
  }
  private async read(id:string):Promise<CandidateRecord|null>{
    if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid workshop candidate id');await this.initialize();
    const path=join(this.options.stateDirectory,'records',id+'.json');
    try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>this.limits.patchBytes*4)throw Error('Unsafe workshop record');
      const text=await readFile(path,'utf8');if(Buffer.byteLength(text)>this.limits.patchBytes*4)throw Error('Workshop record exceeds budget');const record=JSON.parse(text) as CandidateRecord;
      if(record.id!==id||!Array.isArray(record.changes)||record.changes.length>32||record.changes.some(c=>!safePath(c.path)||protectedPath(c.path)||c.content!==null&&typeof c.content!=='string'))throw Error('Invalid workshop record');return record;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  private async required(id:string){const record=await this.read(id);if(!record)throw Error('Workshop candidate unavailable');return record;}
  async get(id:string){const record=await this.read(id);if(!record)return null;await this.assertPolicy(record);return summary(record);}
  async list(){await this.initialize();const names=await readdir(join(this.options.stateDirectory,'records'));if(names.length>this.limits.maximumCandidates)throw Error('Workshop record budget');const rows:WorkshopCandidateSummary[]=[];for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const record=await this.get(name.slice(0,-5));if(record)rows.push(record);}return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async review(candidateId:string):Promise<WorkshopCandidateReview>{
      const record = await this.required(candidateId), initial = JSON.stringify(record), repo = this.repo(record.repositoryId);
      if (!record.candidateRevision || record.state === 'preparing') throw new Error('Candidate is not ready for review');
      await this.assertPolicy(record);
      const baseline = this.directory(record, 'baseline');
      if (await realpath(baseline) !== baseline) throw new Error('Unsafe review baseline');
      const changes: WorkshopCandidateReview['changes'] = [];
      for (const change of record.changes) {
        
        if (!safePath(change.path) || protectedPath(change.path) || !repo.allowedPaths.includes(change.path) || repo.protectedPaths?.includes(change.path)) throw new Error('Review path is outside authority');
        const path = await this.assertFile(baseline, change.path);
        const stat = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
        if (stat && (!stat.isFile() || stat.size > this.limits.patchBytes)) throw new Error('Review baseline exceeds file budget');
        const before = stat ? await readFile(path, 'utf8') : null;
        if ((before === null ? null : hash(before)) !== change.expectedContentHash) throw new Error('Review baseline was changed');
        changes.push({path: change.path, before, after: change.content});
        if (Buffer.byteLength(JSON.stringify(changes)) > this.limits.patchBytes * 2) throw new Error('Review exceeds patch budget');
      }
      await this.assertPolicy(record);
      if(JSON.stringify(await this.required(candidateId))!==initial)throw Error("Workshop candidate changed during review");
      return {candidate: summary(record), changes};

  }
  private repo(id: string) {
    const repo = this.options.repositories.find(r => r.id === id); if (!repo) throw new Error('Workshop repository is not authorized'); return repo;
  }
  private directory(record: CandidateRecord, kind: string) { return join(this.options.stateDirectory, 'worktrees', `${record.id}-${kind}`); }
  private async policyDigest(repo: WorkshopRepository) {
    const checks = [];
    for (const check of repo.acceptanceChecks) {
      if (await realpath(check.scriptPath) !== check.scriptPath || !(await lstat(check.scriptPath)).isFile()) throw new Error('Unsafe acceptance check');
      const bytes = await readFile(check.scriptPath);
      if (bytes.length > this.limits.patchBytes) throw new Error('Acceptance check exceeds budget');
      checks.push({id: check.id, digest: hash(bytes)});
    }
    return hash(JSON.stringify({repo, checks, limits: this.limits, node: this.options.nodeExecutable ?? process.execPath}));
  }
  private async assertPolicy(record: CandidateRecord) {
    if (record.policyDigest !== await this.policyDigest(this.repo(record.repositoryId))) throw new Error('Workshop policy or independent acceptance changed; prepare a new candidate');
  }
  private async assertFile(root: string, path: string) {
    const full = join(root, path);
    for (let current = full; within(root, current) && current !== root; current = dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Workshop does not follow symbolic links'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return full;
  }
}
