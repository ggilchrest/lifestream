export type PersonaProfile = { corePersona: Record<string, unknown>; adaptivePersonaPolicy: { dimensions: unknown[] } };
export function projectPersona(profile: PersonaProfile): string { return JSON.stringify({ corePersona: profile.corePersona, adaptivePersona: profile.adaptivePersonaPolicy.dimensions }); }
