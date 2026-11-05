import { contractFailure, contractSuccess, validateUnifiedDesktopRecord, type ContractPin } from './unified-desktop-contracts.ts';
import type { ValidationResult } from './validator.ts';
import type { TimelinePage } from './conversation-history.types.ts';
export type * from './conversation-history.types.ts';
export const CONVERSATION_HISTORY_SCHEMA_ID = 'https://lifestream.dev/contracts/conversation-history/1.0.0';
export function validateConversationHistoryRecord(kind: string, value: unknown, pin?: ContractPin): ValidationResult {
  const result = validateUnifiedDesktopRecord('conversation-history', kind, value, pin);
  if (!result.valid || !value || typeof value !== 'object') return result;
  const v = value as Record<string, unknown>;
  if (kind === 'TimelinePage') {
    const page = value as TimelinePage;
    const seen = new Set<string>();
    let order = -1;
    for (const entry of page.entries) {
      if (entry.conversationId !== page.conversationId || seen.has(entry.entryId) || entry.order <= order) return contractFailure('ordering', 'timeline page must have distinct ordered entries in one conversation');
      seen.add(entry.entryId); order = entry.order;
    }
  }
  if (kind === 'SearchPage' && v.state === 'unavailable' && (Array.isArray(v.results) && v.results.length || v.nextCursor !== null)) return contractFailure('availability', 'unavailable search cannot publish results');
  if (kind === 'SearchPage' && Array.isArray(v.results) && v.results.some(hit => /[<>"']|&(?!amp;|lt;|gt;|quot;|#39;)/.test((hit as {excerpt: string}).excerpt))) return contractFailure('escaping', 'search excerpt must be escaped');
  if (kind === 'TimelineEntry' || kind === 'ConversationSummary') {
    const end = kind === 'TimelineEntry' ? v.updatedAt : v.lastActivityAt;
    if (Date.parse(v.createdAt as string) > Date.parse(end as string)) return contractFailure('time', 'record times are reversed');
  }
  return result;
}
/** A gap requires an owner snapshot; a stale context cannot publish to a new user. */
export function admitHistoryEvent(sequence: number, lastSequence: number, generation: number, currentGeneration: number): ValidationResult {
  if (![sequence,lastSequence,generation,currentGeneration].every(v => Number.isSafeInteger(v) && v >= 0)) return contractFailure('invalidRequest', 'invalid event position');
  if (generation !== currentGeneration) return contractFailure('scopeChanged', 'history context changed');
  if (sequence !== lastSequence + 1) return contractFailure('restartPage', 'history snapshot required');
  return contractSuccess();
}
