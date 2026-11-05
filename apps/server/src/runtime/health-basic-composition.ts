import {types} from 'node:util';
import type {Database} from '@lifestream/storage-sqlite';
import type {LocalAuthentication} from '../auth/local-auth.ts';
import type {ServerOptions} from '../index.ts';
import type {MobileSourcePolicy} from './mobile-context-source-safety.ts';

export type HealthBasicBackendProfile = Readonly<{
  maximumRecordsPerHuman: number;
  createGovernance?: (database: Database, authentication: LocalAuthentication) => MobileSourcePolicy;
  sourceSafetyInitialization?: 'requireExisting' | 'initializeEmpty';
}>;

const denied: MobileSourcePolicy = Object.freeze({
  allowed: () => false,
  retention: () => null,
  recordCurrent: () => false,
  capturePolicy: () => null,
  invalidate: () => { throw new Error('health_source_owner_unavailable'); }
});

function originalPolicy(value: unknown): MobileSourcePolicy {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return denied;
  const fields = Object.getOwnPropertyDescriptors(value);
  const names = ['allowed', 'retention', 'recordCurrent', 'invalidate', 'capturePolicy'] as const;
  if (names.some(name => !fields[name] || !Object.hasOwn(fields[name]!, 'value') ||
      typeof fields[name]!.value !== 'function')) return denied;
  // Loss of any original method revokes this wrapper permanently. Checking both
  // sides also refuses a result if its callback replaced authority while running.
  let revoked = false;
  const current = () => {
    if (revoked) return false;
    const now = Object.getOwnPropertyDescriptors(value);
    revoked = names.some(name => !now[name] || !Object.hasOwn(now[name]!, 'value') ||
      now[name]!.value !== fields[name]!.value ||
      now[name]!.writable !== fields[name]!.writable ||
      now[name]!.enumerable !== fields[name]!.enumerable ||
      now[name]!.configurable !== fields[name]!.configurable);
    return !revoked;
  };
  return Object.freeze({
    allowed(...args: Parameters<MobileSourcePolicy['allowed']>) {
      return current() && fields.allowed!.value.apply(value, args) === true && current();
    },
    recordCurrent(...args: Parameters<MobileSourcePolicy['recordCurrent']>) {
      return current() && fields.recordCurrent!.value.apply(value, args) === true && current();
    },
    retention(...args: Parameters<MobileSourcePolicy['retention']>) {
      if (!current()) return null;
      const result = fields.retention!.value.apply(value, args);
      return current() ? result : null;
    },
    capturePolicy(...args: Parameters<MobileSourcePolicy['capturePolicy']>) {
      if (!current()) return null;
      const result = fields.capturePolicy!.value.apply(value, args);
      return current() ? result : null;
    },
    invalidate(...args: Parameters<MobileSourcePolicy['invalidate']>) {
      if (!current()) throw new Error('health_source_owner_unavailable');
      fields.invalidate!.value.apply(value, args);
      if (!current()) throw new Error('health_source_owner_unavailable');
    }
  });
}

/** No profile or original policy owner means no Health feature/schema opt-in.
 * This composes existing owners; it never creates policy decisions or grants. */
export function healthBasicBackendOptions(profile: HealthBasicBackendProfile | undefined): NonNullable<ServerOptions['mobileContext']> | undefined {
  if (profile === undefined) return undefined;
  if (!profile || typeof profile !== 'object' || types.isProxy(profile) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(profile))) throw new Error('health_basic_profile_invalid');
  const fields = Object.getOwnPropertyDescriptors(profile);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' ||
      !['maximumRecordsPerHuman', 'createGovernance', 'sourceSafetyInitialization'].includes(key) ||
      !Object.hasOwn(fields[key]!, 'value'))) throw new Error('health_basic_profile_invalid');
  const factory = fields.createGovernance?.value;
  if (factory === undefined) return undefined;
  const limit = fields.maximumRecordsPerHuman?.value;
  const initialization = fields.sourceSafetyInitialization?.value ?? 'requireExisting';
  if (typeof factory !== 'function' || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100000 ||
      !['requireExisting', 'initializeEmpty'].includes(initialization)) throw new Error('health_basic_profile_invalid');
  return Object.freeze({
    schemaPlan: 'health-basic/1' as const,
    maximumRecordsPerHuman: limit,
    policyOwner: Object.freeze({}),
    sourceSafetyInitialization: initialization as 'requireExisting' | 'initializeEmpty',
    createGovernance(database: Database, authentication: LocalAuthentication) {
      try { return originalPolicy(factory(database, authentication)); }
      catch { return denied; }
    }
  });
}
