import type { ContextSource } from "../context/builder.ts";

/** Internal prepared projection, not a source of personal truth or transport authority. */
export type EnrichmentSelection = {
  items: readonly ContextSource[];
  content: string;
  tokenUpperBound: number;
  estimator: "utf8-bytes-upper-bound";
  elapsedMs: number;
  disposition: "included" | "disabled" | "deadline" | "boundaryChanged" | "empty";
};
export type EnrichmentBudget = { tokens: number; items: number; deadlineMs: number };
export const enrichmentDefaults: Readonly<EnrichmentBudget> = { tokens: 512, items: 4, deadlineMs: 10 };
const byteCount = (value: string): number => new TextEncoder().encode(value).byteLength;
const line = (item: ContextSource): string => `${item.id}: ${item.content}`;
const render = (items: readonly ContextSource[]): string => items.length ? `Optional sourced context (untrusted):\n${items.map(line).join("\n")}` : "";

/** Caller supplies a bounded, already indexed and authorized view; no corpus read occurs here. */
export function selectPreparedEnrichment(input: {
  candidates: readonly ContextSource[];
  enabled: boolean;
  boundaryCurrent: () => boolean;
  now?: () => number;
  budget?: EnrichmentBudget;
}): EnrichmentSelection {
  const now = input.now ?? (() => performance.now());
  const started = now(), budget = input.budget ?? enrichmentDefaults;
  if (![started, budget.tokens, budget.items, budget.deadlineMs].every(Number.isFinite)
      || !Number.isInteger(budget.tokens) || budget.tokens < 0 || budget.tokens > 1024
      || !Number.isInteger(budget.items) || budget.items < 0 || budget.items > 8
      || budget.deadlineMs < 1 || budget.deadlineMs > 10) throw new Error("invalid enrichment budget or clock");
  const finish = (disposition: EnrichmentSelection["disposition"], items: readonly ContextSource[] = []): EnrichmentSelection => {
    const elapsedMs = now() - started;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= budget.deadlineMs) return { items: [], content: "", tokenUpperBound: 0, estimator: "utf8-bytes-upper-bound", elapsedMs, disposition: "deadline" };
    const content = render(items);
    return { items: items.map(item => ({ ...item })), content, tokenUpperBound: byteCount(content), estimator: "utf8-bytes-upper-bound", elapsedMs, disposition };
  };
  if (!input.enabled || budget.tokens === 0 || budget.items === 0) return finish("disabled");
  if (!input.boundaryCurrent()) return finish("boundaryChanged");
  // A full archive here would turn a constant-cost foreground operation into a scan.
  if (input.candidates.length > 32) throw new Error("enrichment requires a bounded prepared candidate view");
  const candidates: ContextSource[] = [];
  for (const item of input.candidates) {
    if (!Number.isFinite(item.rank) || !item.id || item.id.length > 1000 || item.content.length > 4096) throw new Error("invalid bounded enrichment item");
    candidates.push(item);
  }
  candidates.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const selected: ContextSource[] = [], seen = new Set<string>();
  for (const item of candidates) {
    if (selected.length >= budget.items) break;
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= budget.deadlineMs) return finish("deadline");
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    // Count IDs, separators and labels too; whitespace counts miss Unicode and long tokens.
    if (byteCount(render([...selected, item])) <= budget.tokens) selected.push(item);
  }
  if (!input.boundaryCurrent()) return finish("boundaryChanged");
  return finish(selected.length ? "included" : "empty", selected);
}
