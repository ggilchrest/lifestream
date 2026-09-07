export type MemoryRecord = { id: string; assistantId: string; content: string; provenance: Record<string, unknown>; lifecycle: Record<string, unknown>; createdAt: string };
export interface MemoryPort { recall(assistantId: string, query: string, limit: number): MemoryRecord[]; reinforce(assistantId: string, memoryId: string): void; }
