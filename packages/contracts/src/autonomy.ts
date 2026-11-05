/** Owner state and bounded improvement records. Source text is never authority. */
export type AutonomyScope = { principalId: string; assistantId: string; relationshipId: string };
export type AutonomyGoal = { id: string; text: string };
export type AutonomyMandate = {
  enabled: boolean; away: boolean; allowResearch: boolean; allowWorkshop: boolean;
  dailyCalls: number; dailyComputeMs: number; totalCostLimitUsd: number;
  reflectionIntervalMs: number;
};
export type AutonomyConfiguration = { purpose: string; goals: AutonomyGoal[]; mandate: AutonomyMandate };
export type AutonomySettings = { scope: AutonomyScope; revision: number; configuration: AutonomyConfiguration; updatedAt: string };
export type AutonomyEvidenceReference = {
  id: string; revision: string; digest: string; occurredAt: string;
  kind: 'conversation' | 'memory' | 'telemetry' | 'feedback' | 'outcome' | 'capability';
};
export type AutonomyEvidence = AutonomyEvidenceReference & { content: string };
export type ImprovementProposal = {
  key: string; goalId: string; title: string; observation: string; hypothesis: string;
  uncertainty: 'medium' | 'high'; expectedBenefit: string; priority: number;
  evidenceRefs: AutonomyEvidenceReference[]; requiredAuthority: string[];
  budget: { computeMs: number; costUsd: number }; dependencies: string[];
  successMeasure: string; recovery: string;
};
export type ImprovementState = 'observed' | 'investigating' | 'proposed' | 'experimenting' | 'readyForReview' | 'approved' | 'evaluated' | 'retained' | 'reverted' | 'deferred' | 'rejected' | 'blocked' | 'abandoned';
export type ImprovementCandidate = {
  id: string; baseRevision: string; candidateRevision: string; outcomeDigest: string; passed: boolean;
};
export type ImprovementDecision = { id: string; actor: string; at: string; decision: 'approve' | 'reject' | 'defer' | 'revoke' | 'abandon' | 'rollback'; scopeDigest: string; note: string };
export type ImprovementRecord = {
  id: string; scope: AutonomyScope; revision: number; state: ImprovementState;
  proposal: ImprovementProposal; evidenceDigest: string; scopeDigest: string;
  candidate: ImprovementCandidate | null; decision: ImprovementDecision | null;
  decisionHistory: ImprovementDecision[];
  evaluation: { outcome: 'retained' | 'reverted'; summary: string; at: string } | null;
  createdAt: string; updatedAt: string;
};
export type AutonomyJob = {
  id: string; scope: AutonomyScope; kind: 'reflection' | 'briefing' | 'planning' | 'workshop'; key: string; improvementId: string | null;
  state: 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  configurationRevision: number; attempts: number; nextAt: number;
  sourceDigest: string; checkpoint: string | null; reason: string;
  reservedComputeMs: number; reservedCostUsd: number; observedComputeMs: number;
  createdAt: string; updatedAt: string;
};
export type PreparedAutonomyBriefing = {generatedAt:string;sourceDigest:string;summary:string;readyIds:string[];outcomeIds:string[];decisionIds:string[];rejectedIds:string[]};
export type AutonomyCandidatePlan = {repositoryId:string;baseRevision?:string;changes:{path:string;expectedContentHash:string|null;content:string|null}[]};
export const autonomyLimits = Object.freeze({ maximumGoals: 16, maximumSources: 32, sourceCharacters: 2000,
  sourceTotalCharacters: 24000, maximumProposals: 8, maximumRecords: 128, maximumJobs: 128,
  maximumAttempts: 3, reflectionDeadlineMs: 30000, inputTokens: 12000, outputTokens: 2048,
  outputBytes: 16000, dailyCalls: 48, dailyComputeMs: 3600000, totalCostLimitUsd: 100,
});
export function defaultAutonomyConfiguration(): AutonomyConfiguration {
  return { purpose: 'Help the owner turn intentions into outcomes, reduce the effort of managing life and projects, and enrich their interests through a thoughtful, increasingly capable relationship.',
    goals: [
      {id:'follow-through',text:'Reduce cognitive and administrative burden; support planning, remembering, organizing, and follow-through.'},
      {id:'understanding',text:'Understand preferences, constraints, interests, and the reasons behind them.'},
      {id:'discovery',text:'Contribute to enjoyable discovery, creativity, hobbies, and experiences.'},
      {id:'reliability',text:'Improve usefulness, communication, and reliability based on evidence.'},
      {id:'agency',text:"Respect the owner's agency, attention, and chosen initiative level."}
    ], mandate:{enabled:false,away:false,allowResearch:false,allowWorkshop:false,dailyCalls:4,dailyComputeMs:120000,totalCostLimitUsd:0,reflectionIntervalMs:21600000} };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('autonomy_invalid_object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !(key in value))) throw Error('autonomy_invalid_fields');
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw Error('autonomy_invalid_text');
  return value.trim();
}
function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw Error('autonomy_invalid_limit');
  return value;
}
export function validateAutonomyScope(value: AutonomyScope): AutonomyScope {
  const input=object(value); keys(input,['principalId','assistantId','relationshipId']);
  for (const id of Object.values(input)) if (typeof id!=='string'||!/^[a-zA-Z0-9._:-]{1,256}$/.test(id)) throw Error('autonomy_invalid_scope');
  return structuredClone(value);
}
export function validateAutonomyConfiguration(value: unknown): AutonomyConfiguration {
  const input=object(value);keys(input,['purpose','goals','mandate']);text(input.purpose,2000);
  if(!Array.isArray(input.goals)||!input.goals.length||input.goals.length>autonomyLimits.maximumGoals)throw Error('autonomy_invalid_goals');
  const ids=new Set<string>();for(const raw of input.goals){const goal=object(raw);keys(goal,['id','text']);const id=text(goal.id,80);if(!/^[a-zA-Z0-9_-]+$/.test(id)||ids.has(id))throw Error('autonomy_invalid_goal');ids.add(id);text(goal.text,1000);}
  const mandate=object(input.mandate);keys(mandate,['enabled','away','allowResearch','allowWorkshop','dailyCalls','dailyComputeMs','totalCostLimitUsd','reflectionIntervalMs']);
  for(const field of ['enabled','away','allowResearch','allowWorkshop'])if(typeof mandate[field]!=='boolean')throw Error('autonomy_invalid_mandate');
  if(!Number.isInteger(mandate.dailyCalls))throw Error('autonomy_invalid_limit');
  number(mandate.dailyCalls,0,autonomyLimits.dailyCalls);number(mandate.dailyComputeMs,0,autonomyLimits.dailyComputeMs);
  number(mandate.totalCostLimitUsd,0,autonomyLimits.totalCostLimitUsd);number(mandate.reflectionIntervalMs,60000,30*86400000);
  return structuredClone(value) as AutonomyConfiguration;
}
export function validateAutonomyEvidence(value: unknown): AutonomyEvidence[] {
  if(!Array.isArray(value)||value.length>autonomyLimits.maximumSources)throw Error('autonomy_invalid_sources');
  const ids=new Set<string>();let total=0;
  for(const raw of value){const source=object(raw);keys(source,['id','revision','digest','occurredAt','kind','content']);
    const id=text(source.id,256);if(ids.has(id))throw Error('autonomy_duplicate_source');ids.add(id);text(source.revision,128);
    if(typeof source.digest!=='string'||!/^[a-f0-9]{64}$/.test(source.digest))throw Error('autonomy_invalid_digest');
    if(typeof source.occurredAt!=='string'||!source.occurredAt.endsWith('Z')||!Number.isFinite(Date.parse(source.occurredAt)))throw Error('autonomy_invalid_source_time');
    if(!['conversation','memory','telemetry','feedback','outcome','capability'].includes(String(source.kind)))throw Error('autonomy_invalid_source_kind');
    total+=text(source.content,autonomyLimits.sourceCharacters).length;
  }
  if(total>autonomyLimits.sourceTotalCharacters)throw Error('autonomy_source_budget');return structuredClone(value) as AutonomyEvidence[];
}
export function validateImprovementProposal(value: unknown, configuration: AutonomyConfiguration, sources: AutonomyEvidence[]): ImprovementProposal {
  const input=object(value);keys(input,['key','goalId','title','observation','hypothesis','uncertainty','expectedBenefit','priority','evidenceRefs','requiredAuthority','budget','dependencies','successMeasure','recovery']);
  if(!/^[a-zA-Z0-9_-]+$/.test(text(input.key,80)))throw Error('autonomy_invalid_key');
  if(!configuration.goals.some(goal=>goal.id===input.goalId))throw Error('autonomy_unknown_goal');
  for(const field of ['title','observation','hypothesis','expectedBenefit','successMeasure','recovery'])text(input[field],field==='title'?160:1200);
  if(!['medium','high'].includes(String(input.uncertainty)))throw Error('autonomy_unsupported_certainty');
  number(input.priority,1,5);
  if(!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length||input.evidenceRefs.length>16)throw Error('autonomy_missing_evidence');
  const unique=new Set<string>();for(const raw of input.evidenceRefs){const reference=object(raw);keys(reference,['id','revision','digest','occurredAt','kind']);const source=sources.find(s=>s.id===reference.id);
    if(!source||unique.has(source.id)||['revision','digest','occurredAt','kind'].some(key=>reference[key]!==source[key as keyof AutonomyEvidence]))throw Error('autonomy_source_mismatch');unique.add(source.id);
  }
  for(const field of ['requiredAuthority','dependencies']){const list=input[field];if(!Array.isArray(list)||list.length>16||new Set(list).size!==list.length)throw Error('autonomy_invalid_dependencies');for(const item of list)text(item,256);}
  const budget=object(input.budget);keys(budget,['computeMs','costUsd']);number(budget.computeMs,0,autonomyLimits.dailyComputeMs);number(budget.costUsd,0,autonomyLimits.totalCostLimitUsd);
  return structuredClone(value) as ImprovementProposal;
}
