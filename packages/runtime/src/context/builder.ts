import { describeRelationshipControls } from "./controls.ts";
export { relationshipControlDefaults, relationshipControlInventory } from "./controls.ts";
export type ContextSource = { id: string; content: string; rank: number };
// Conservative estimate for byte-based tokenization; the serving tokenizer is not measured here.
const estimateTokens = (content: string): number => new TextEncoder().encode(content).byteLength;
export function buildContext(sources: ContextSource[], maxItems = 4, maxTokens = 512): ContextSource[] {
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 8 || !Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 1024) throw new Error("invalid bounded context allocation");
  const selected: ContextSource[] = [];
  let usedTokens = 0;
  for (const source of [...sources].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))) {
    if (selected.length >= maxItems) break;
    const sourceTokens = estimateTokens(`${source.id}=${source.content}`) + 16;
    if (usedTokens + sourceTokens > maxTokens) continue;
    selected.push({ ...source });
    usedTokens += sourceTokens;
  }
  return selected;
}
export type PreparedRelationshipContext = { discoveryContent?: string; profileRevision: string; relationshipRevision: string; configurationRevision: string; configurationControls?: Readonly<Record<string, number>>; compiledConventions?: {lane: string; text: string; sources: {id:string;revision:number;family:string}[]}[]; approvedBaseline: readonly string[]; criticalCorrections: readonly string[]; relevantContext: readonly ContextSource[]; limitations: readonly string[] };
export function formatPreparedRelationshipContext(context: PreparedRelationshipContext): string { const relevant = "compilerRevision" in context ? [...context.relevantContext] : buildContext([...context.relevantContext]); const controls = context.configurationControls ? Object.entries(context.configurationControls).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(", ") : "default"; return [`Prepared relationship context [profile=${context.profileRevision};relationship=${context.relationshipRevision};configuration=${context.configurationRevision}]`, `Expression controls: ${controls}. ${describeRelationshipControls(context.configurationControls ?? {})}`, ...(context.compiledConventions ? [`Compiled conventions with source links: ${JSON.stringify(context.compiledConventions)}`] : [`Approved baseline: ${context.approvedBaseline.join(" | ") || "none"}`, `Critical corrections: ${context.criticalCorrections.join(" | ") || "none"}`, `Relevant context: ${relevant.map((source) => `${source.id}=${source.content}`).join(" | ") || "none"}`]), `Limitations: ${context.limitations.join(" | ") || "none"}`, ...(context.discoveryContent ? [context.discoveryContent] : [])].join("\n"); }

export type RelationshipContextRecord = { id: string; content: string; revision: number; sourceFamily: string; status: string; use: "baseline" | "correction" | "relevant"; personalization: boolean; mention: boolean; uncertainty?: string };
export type ContextOmission = { id: string; revision: number; reason: string };
export type ContextSelection = { id: string; revision: number; sourceFamily: string; lane: RelationshipContextRecord["use"]; byteContribution: number };
export type CompiledRelationshipContext = PreparedRelationshipContext & { compilerRevision: string; representationRevision: string; builtAt: string; freshUntil: string; sourceRevisions: readonly string[]; selections: readonly ContextSelection[]; omissions: readonly ContextOmission[]; budget: { maximumBytes: number; usedBytes: number; estimator: "utf8-bytes-upper-bound" }; preparationCount: 1 };
export const RELATIONSHIP_COMPILER_REVISION = "relationship-context:6";
const bytes = (value: string) => new TextEncoder().encode(value).length;
const terms = (value: string) => new Set((value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !["the", "and", "that", "this", "with", "for", "are", "was", "user", "prefers", "please", "about", "explain"].includes(word)));
export function compileRelationshipContext(input: { records: readonly RelationshipContextRecord[]; userInput: string; audienceScope: "authenticatedSession" | "unknown"; profileRevision: string; relationshipRevision: string; configurationRevision: string; controls?: Readonly<Record<string, number>>; representation?: "recordOriented"|"conventionOriented"; now?: number }): CompiledRelationshipContext {
  const now = input.now ?? Date.now(), maximumBytes = 8192;
  const view: CompiledRelationshipContext = { profileRevision: input.profileRevision, relationshipRevision: input.relationshipRevision, configurationRevision: input.configurationRevision, ...(input.controls ? { configurationControls: input.controls } : {}), compilerRevision: RELATIONSHIP_COMPILER_REVISION, representationRevision: input.representation === "conventionOriented" ? "convention-oriented:1" : "record-oriented:1", builtAt: new Date(now).toISOString(), freshUntil: new Date(now + 120_000).toISOString(), approvedBaseline: [], criticalCorrections: [], relevantContext: [], sourceRevisions: [], selections: [], omissions: [], budget: { maximumBytes, usedBytes: 0, estimator: "utf8-bytes-upper-bound" }, preparationCount: 1, limitations: ["Current explicit requests and runtime/policy/Core Persona limits take precedence over historical expression preferences.", "Use context only when helpful to the current task; never recite a profile or imply a recalled fact authorizes contact or an effect.", "Optional rich-archive recall is unavailable; mandatory approved conventions and corrections do not require recall.", "Selection and byte contributions are observed inputs, not causal proof of reply behavior."] };
  const selected: ContextSelection[] = [], omitted: ContextOmission[] = [], eligible: RelationshipContextRecord[] = [];
  const records = [...input.records].sort((a,b) => a.id.localeCompare(b.id));
  for (const record of records) {
    let reason: string | undefined;
    if (input.audienceScope !== "authenticatedSession") reason = "audience authorization insufficient";
    else if (record.status !== "approved") reason = `lifecycle ${record.status}`;
    else if (!record.personalization) reason = "personalization use excluded";
    else if (!record.mention) reason = "mention restriction cannot establish confidentiality; withheld before inference";
    else if (record.content.length > 4000) reason = "record exceeds bounded projection";
    if (reason) omitted.push({ id: record.id, revision: record.revision, reason }); else eligible.push(record);
  }
  const payloadCapacity = maximumBytes - bytes(formatPreparedRelationshipContext(view)) - 128;
  let used = 0;
  const take = (record: RelationshipContextRecord): boolean => {
    const size = input.representation === "conventionOriented" ? bytes(JSON.stringify({lane:record.use,text:record.content,sources:[{id:record.id,revision:record.revision,family:record.sourceFamily}]})) + 2 : bytes(record.content) + bytes(record.id) + 16;
    if (used + size > payloadCapacity) return false;
    used += size; selected.push({ id: record.id, revision: record.revision, sourceFamily: record.sourceFamily, lane: record.use, byteContribution: size }); return true;
  };
  const mandatory = eligible.filter(record => record.use !== "relevant");
  for (const record of mandatory) {
    if (record.use !== "correction" && input.controls?.personalizationIntensity === 0) { omitted.push({ id: record.id, revision: record.revision, reason: "personalization disabled" }); continue; }
    if (!take(record)) throw new Error("Mandatory relationship boundaries exceed the context budget; review them before personalized generation");
    (record.use === "correction" ? view.criticalCorrections as string[] : view.approvedBaseline as string[]).push(record.content);
  }
  const optionalLimit = Math.max(0,Math.min(4,Math.ceil(4 * (input.controls?.callbackFrequency ?? 1))));
  const requestTerms = terms(input.userInput.slice(0, 8000));
  const ranked = eligible.filter(record => record.use === "relevant").map(record => ({ record, score: [...terms(record.content)].filter(term => requestTerms.has(term)).length })).sort((a,b) => b.score-a.score || a.record.id.localeCompare(b.record.id));
  for (const { record, score } of ranked) {
    const reason = input.controls?.personalizationIntensity === 0 ? "personalization disabled" : input.controls?.callbackFrequency === 0 ? "optional personal callbacks disabled" : score === 0 ? "no current-task relevance" : score / (score + 0.25) < (input.controls?.relevanceThreshold ?? 0.7) ? "below lexical relevance threshold" : (view.relevantContext.length >= optionalLimit || !take(record)) ? "bounded allocation" : undefined;
    if (reason) omitted.push({ id: record.id, revision: record.revision, reason });
    else (view.relevantContext as ContextSource[]).push({ id: record.id, content: record.content, rank: -score });
  }
  if(input.representation === "conventionOriented") {
    const groups = new Map<string,NonNullable<PreparedRelationshipContext["compiledConventions"]>[number]>();
    for(const selection of selected){const record=records.find(r=>r.id===selection.id)!;const key=record.use==="correction"?`correction:${record.id}`:`${record.use}:${record.content.trim().toLowerCase().replace(/\s+/gu," ")}`;const group=groups.get(key)??{lane:record.use,text:record.content,sources:[]};group.sources.push({id:record.id,revision:record.revision,family:record.sourceFamily});groups.set(key,group);}
    view.compiledConventions=[...groups.values()];
  }
  view.selections = selected; view.omissions = omitted; view.sourceRevisions = records.map(record => `${record.id}:${record.revision}`); view.budget.usedBytes = bytes(formatPreparedRelationshipContext(view)); if (view.budget.usedBytes > maximumBytes) throw new Error("Prepared relationship view exceeds bounded context capacity");
  if (input.audienceScope !== "authenticatedSession") view.limitations = [...view.limitations, "Personal relationship payload withheld because audience scope is unknown."];
  return view;
}
