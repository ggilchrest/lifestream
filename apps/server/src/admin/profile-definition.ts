import type { AssistantProfile } from '@lifestream/storage-sqlite';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Build a fresh revision from validated authored changes, preserving omitted fields.
 * Names do not regenerate persona prose. Components are whole replacements;
 * explicit null clears one, while omission keeps its exact current reference.
 * A base comes only from the already-authorized Assistant's revision list.
 */
export function profileFor(assistantId: string, profileId: string, revision: number, input: Record<string, unknown>, actor: string, base?: AssistantProfile): AssistantProfile {
  if (base && base.assistantId !== assistantId) throw new Error('Profile base belongs to another Assistant');
  const displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : typeof base?.displayName === 'string' ? base.displayName : 'Example Assistant';
  const corePersona = input.corePersona === undefined && base?.corePersona !== undefined ? base.corePersona : {
    canonicalName: displayName,
    identityStatement: 'A user-authored Assistant.',
    values: ["Respect the user's agency."],
    prohibitions: ['Do not claim authority the Assistant does not have.'],
    relationshipBoundaries: ['Keep the relationship clear and user-directed.'],
    styleBoundaries: ['Stay honest about uncertainty and capability limits.'],
    ...object(base?.corePersona),
    ...object(input.corePersona)
  };
  const component = (key: string, fallback: unknown) => input[key] !== undefined ? input[key] : base?.[key] !== undefined ? base[key] : fallback;
  return structuredClone({
    schemaVersion: '2.0.0', assistantId, profileId, revision, status: 'draft',
    createdAt: new Date().toISOString(), createdBy: actor, displayName, corePersona,
    adaptivePersonaPolicy: component('adaptivePersonaPolicy', { dimensions: [] }),
    voiceProfile: component('voiceProfile', null),
    embodimentProfile: component('embodimentProfile', null),
    presentationProfile: component('presentationProfile', null),
    providerProfile: component('providerProfile', { inference: 'fixture', memory: 'fixture', stt: 'fixture', tts: 'fixture', renderer: 'fixture' }),
    ...(base?.extensions === undefined && input.extensions === undefined ? {} : { extensions: { ...object(base?.extensions), ...object(input.extensions) } })
  });
}
