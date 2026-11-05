import { createHash } from 'node:crypto';
import { createContractValidator } from '@lifestream/contracts';
import { unifiedDesktopSnapshot } from '@lifestream/contracts/unified-desktop-contracts';
import type { AssistantProfile } from '@lifestream/storage-sqlite';
import { understandingDigest } from '@lifestream/storage-sqlite';

export const PROMPT_DOCUMENT_KEY = 'lifestream.prompt-document';
const validator = createContractValidator();
type Section = { sectionId: string; kind: 'identityAddition' | 'personality'; provenance: 'manual' | 'legacyAuthored'; text: string };
export type PromptDocument = { schemaVersion: '1.0.0'; documentId: string; revision: number; scope: 'assistant'; sections: Section[] };
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export function parsePromptDocument(value: unknown): PromptDocument {
  const snapshot = unifiedDesktopSnapshot(value, 32_768);
  if (!snapshot || !validator.validate('https://lifestream.dev/contracts/prompt-document/1.0.0', snapshot).valid) throw new Error('Invalid bounded authored prompt document');
  const doc = snapshot as PromptDocument;
  if (!Number.isSafeInteger(doc.revision)) throw new Error('Prompt document revision must be a safe integer');
  if (new Set(doc.sections.map(s => s.sectionId)).size !== doc.sections.length || doc.sections.some(s => !s.text.trim() || s.text.includes('\0') || /[\uD800-\uDFFF]/u.test(s.text) || Buffer.byteLength(s.text) > 16_384) || Buffer.byteLength(JSON.stringify(doc)) > 32_768) throw new Error('Prompt sections require unique IDs and bounded, nonempty text (16 KiB per section, 32 KiB per document)');
  return structuredClone(doc);
}

export function promptDocument(profile: AssistantProfile | undefined): PromptDocument | undefined {
  const value = object(profile?.extensions)?.[PROMPT_DOCUMENT_KEY];
  return value === undefined ? undefined : parsePromptDocument(value);
}

function validatedExtensionDocument(input: unknown): PromptDocument {
  const extensions = object(unifiedDesktopSnapshot(input, 33_024));
  if (!extensions || Object.keys(extensions).length !== 1 || !Object.hasOwn(extensions, PROMPT_DOCUMENT_KEY)) throw new Error('Only the authored prompt-document extension is editable through this operation');
  return parsePromptDocument(extensions[PROMPT_DOCUMENT_KEY]);
}

export function validatePromptExtensions(input: unknown): void {
  validatedExtensionDocument(input);
}

export function validatePromptTransition(base: AssistantProfile | undefined, extensions: unknown, history: AssistantProfile[] = base ? [base] : []): void {
  const next = validatedExtensionDocument(extensions);
  const assistantId = base?.assistantId ?? history[0]?.assistantId;
  if (history.some(profile => profile.assistantId !== assistantId || !Number.isSafeInteger(profile.revision) || profile.revision < 1)) throw new Error('Prompt history must belong to the same Assistant with valid profile revisions');
  const retained = history.map(profile => ({ profileRevision: profile.revision, document: promptDocument(profile) })).filter((entry): entry is {profileRevision:number;document:PromptDocument} => !!entry.document).sort((a,b)=>a.profileRevision-b.profileRevision);
  const prior = promptDocument(base) ?? retained.at(-1)?.document;
  if (!prior) { if (next.revision !== 1) throw new Error('A new prompt document starts at revision 1'); if(next.sections.some(s=>s.provenance==='legacyAuthored'))throw new Error('New prose must be attributed as manual'); return; }
  if (prior.documentId !== next.documentId) throw new Error('Keep the stable prompt document identity when editing an Assistant');
  if (understandingDigest(prior) === understandingDigest(next)) return;
  const maximum = Math.max(prior.revision, ...history.map(profile => promptDocument(profile)).filter((d): d is PromptDocument => !!d && d.documentId === next.documentId).map(d => d.revision));
  if (maximum >= Number.MAX_SAFE_INTEGER || next.revision !== maximum + 1) throw new Error('Prompt document revision is stale; advance beyond all retained document revisions');
  for (const section of next.sections) {
    const historical = retained.filter(entry=>entry.document.documentId===next.documentId).flatMap(entry=>entry.document.sections.filter(s=>s.sectionId===section.sectionId));
    const old = prior.sections.find(s => s.sectionId === section.sectionId) ?? historical.at(-1);
    if (historical.some(s=>s.kind!==section.kind) || old && old.kind !== section.kind) throw new Error('An existing prompt section cannot change kind');
    if (section.provenance === 'legacyAuthored' && (!old || old.text !== section.text || old.provenance !== section.provenance)) throw new Error('Changed or new prose must be attributed as manual');
  }
}

/** Compiles additions only into the existing persona lane. Nothing here can
 * create a policy section, tool grant, runtime fact or relationship authority.
 * Immutable profile identity and document digest pin use on subsequent turns.
 */
export function compileProfilePersona(profile: AssistantProfile): { content: string; digest: string } {
  const doc = promptDocument(profile);
  const content = JSON.stringify(doc ? { corePersona: profile.corePersona, authoredPromptSections: doc.sections } : profile.corePersona);
  if (doc && Buffer.byteLength(content) > 48 * 1024) throw new Error('Authored persona exceeds its 48 KiB compiled budget; shorten the text before saving');
  return { content, digest: createHash('sha256').update(content).digest('hex') };
}
