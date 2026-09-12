export type ContextSource = { id: string; content: string; rank: number };
const estimateTokens = (content: string): number => content.trim() ? content.trim().split(/\s+/u).length : 0;
export function buildContext(sources: ContextSource[], maxItems = 10, maxTokens = 1200): ContextSource[] {
  const selected: ContextSource[] = [];
  let usedTokens = 0;
  for (const source of [...sources].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))) {
    if (selected.length >= maxItems) break;
    const sourceTokens = estimateTokens(source.content);
    if (usedTokens + sourceTokens > maxTokens) continue;
    selected.push({ ...source });
    usedTokens += sourceTokens;
  }
  return selected;
}
export type PreparedRelationshipContext = { profileRevision: string; relationshipRevision: string; configurationRevision: string; configurationControls?: Readonly<Record<string, number>>; approvedBaseline: readonly string[]; criticalCorrections: readonly string[]; relevantContext: readonly ContextSource[]; limitations: readonly string[] };
export function formatPreparedRelationshipContext(context: PreparedRelationshipContext): string { const relevant = buildContext([...context.relevantContext]); const controls = context.configurationControls ? Object.entries(context.configurationControls).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(", ") : "default"; return [`Prepared relationship context [profile=${context.profileRevision};relationship=${context.relationshipRevision};configuration=${context.configurationRevision}]`, `Expression controls: ${controls}`, `Approved baseline: ${context.approvedBaseline.join(" | ") || "none"}`, `Critical corrections: ${context.criticalCorrections.join(" | ") || "none"}`, `Relevant context: ${relevant.map((source) => `${source.id}=${source.content}`).join(" | ") || "none"}`, `Limitations: ${context.limitations.join(" | ") || "none"}`].join("\n"); }
