import { PwceGatewayClient, PwceContextSession } from '@lifestream/providers-pwce';
import type { RuntimeConfig } from '../config/schema.ts';
import { personPlace } from '../runtime/reminder-host.ts';
import { ReminderDisplays, type DisplayBinding } from '../runtime/reminder-displays.ts';

type PersonBinding = {
  owner: string;
  person: string;
  property: string;
  site: string;
  maxAgeMs: number;
  zones: Record<string, string>;
  homeStates?: Record<string, 'home' | 'away'>;
  identity: {
    assistantRef: string;
    endpointRef: string;
    participantRefs: string[];
    audienceRef: string;
  };
};
export type ReminderBindings = { displays: DisplayBinding[]; people: PersonBinding[] };

/** Local composition supplies opaque identity/zone bindings. No discovery or automatic enrollment. */
export function configureReminders(
  bindings: ReminderBindings,
  config: RuntimeConfig,
  options: { now?: () => number; fetchImpl?: typeof fetch; token?: string } = {},
) {
  if (
    !Array.isArray(bindings.people) ||
    bindings.people.length > 128 ||
    new Set(bindings.people.map((b) => b.owner)).size !== bindings.people.length
  )
    throw Error('Invalid reminder person bindings.');
  const now = options.now ?? Date.now,
    reminderDisplays = new ReminderDisplays(bindings.displays, now);
  const profile = config.pwceProfile;
  if (
    bindings.people.length &&
    profile &&
    !['live', 'normal'].includes(profile.executionEnvironmentRef) &&
    !(config.profile === 'test' && options.fetchImpl)
  )
    throw Error('Synthetic presence requires a synthetic endpoint fixture.');
  const people = new Map<string, PersonBinding>();
  for (const person of bindings.people) {
    if (
      Object.values(person.homeStates ?? {}).some((v) => v !== 'home' && v !== 'away') ||
      !profile?.siteRefs.includes(person.site) ||
      ![
        person.person,
        person.property,
        person.owner,
        person.identity?.assistantRef,
        person.identity?.audienceRef,
        person.identity?.endpointRef,
      ].every((v) => typeof v === 'string' && v.length > 0) ||
      person.identity.participantRefs.length !== 1 ||
      typeof person.identity.participantRefs[0] !== 'string' ||
      !Number.isInteger(person.maxAgeMs) ||
      person.maxAgeMs <= 0 ||
      person.maxAgeMs > 86400000 ||
      !Object.values(person.zones).every((x) => typeof x === 'string' && x.length > 0)
    )
      throw Error('Invalid person presence binding.');
    people.set(person.owner, structuredClone(person));
  }
  const token =
    profile && (options.token ?? process.env[config.secretRefs[profile.tokenSecretRef]!.name]);
  if (people.size && (!token || config.providers.world !== 'pwce'))
    throw Error('Configured PWCE reminder presence is unavailable.');
  const client =
    profile && token
      ? new PwceGatewayClient({
          baseUrl: profile.endpoint,
          token,
          requestTimeoutMs: profile.timeoutMs,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
      : undefined;
  const sessions = new Map<string, { session: PwceContextSession; expires: number }>();
  const reminderHost = {
    now,
    close: () => {
      for (const entry of sessions.values()) entry.session.close();
      sessions.clear();
    },
    endpoints: (owner: string) => reminderDisplays.endpoints(owner),
    presence: async (owner: string, signal: AbortSignal) => {
      const binding = people.get(owner);
      if (!binding || !client || !profile) return;
      let entry = sessions.get(owner);
      if (!entry || Date.now() >= entry.expires) {
        entry?.session.close();
        sessions.delete(owner);
        const authority = await client.authority([binding.site], signal, binding.identity);
        if (
          typeof authority.authorityContextRef !== 'string' ||
          typeof authority.expiresAt !== 'string' ||
          !Array.isArray(authority.siteRefs) ||
          authority.siteRefs.length !== 1 ||
          authority.siteRefs[0] !== binding.site
        )
          return;
        const session = new PwceContextSession(
          client,
          {
            ...binding.identity,
            authorityContextRef: authority.authorityContextRef,
            authorityExpiresAt: authority.expiresAt,
            siteRef: binding.site,
            principalRef: profile.principalRef,
            worldRef: profile.worldRef,
            executionEnvironmentRef: profile.executionEnvironmentRef,
            sessionId: authority.authorityContextRef,
            environmentId: profile.lifestreamEnvironmentId,
          },
          { isCurrent: () => !signal.aborted, timeoutMs: profile.timeoutMs },
        );
        entry = { session, expires: Date.parse(authority.expiresAt) };
        sessions.set(owner, entry);
      }
      try {
        return await personPlace(
          entry.session,
          binding.person,
          binding.site,
          binding.property,
          new Map(Object.entries(binding.zones)),
          binding.maxAgeMs,
          now,
          signal,
          binding.homeStates,
        );
      } catch (error) {
        entry.session.close();
        sessions.delete(owner);
        throw error;
      }
    },
  };
  return { reminderHost, reminderDisplays };
}
