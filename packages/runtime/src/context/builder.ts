export type ContextSource = { id: string; content: string; rank: number };
export function buildContext(sources: ContextSource[], maxItems = 10): ContextSource[] { return [...sources].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).slice(0, maxItems).map((s) => ({ ...s })); }
