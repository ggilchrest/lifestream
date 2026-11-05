import {types} from 'node:util';

/** Scheduling/loaded-machine sanity limits, not authority leases or performance
 * targets. Real grant/native expiry, cancellation and gameplay budgets remain
 * independently authoritative. Completion timestamps are never moved forward. */
export const GAME_SANITY_TIMING_DEFAULTS=Object.freeze({
 inspectionFreshnessMs:30000,receiptFreshnessMs:30000,sourceProofFreshnessMs:30000,
 inspectionTimeoutMs:15000,nativeStartupTimeoutMs:60000,nativePreparationTimeoutMs:60000,
 nativePairingTimeoutMs:15000,nativeReadyTimeoutMs:30000,hostIdleTimeoutMs:60000,
 startupOverallTimeoutMs:120000,noProgressTimeoutMs:60000,cleanupTimeoutMs:60000,settlementTimeoutMs:30000,
 readRefreshTimeoutMs:15000,commandRoundTripTimeoutMs:60000,observationFreshnessMs:180000,planningTimeoutMs:60000,visionMaximumDurationMs:60000,visionIdleTimeoutMs:60000,visionSlotAttemptTimeoutMs:2000,
});
export type GameSanityTiming=Readonly<{[K in keyof typeof GAME_SANITY_TIMING_DEFAULTS]:number}>;
export type GameSanityTimingInput=Partial<GameSanityTiming>;
const maxima:GameSanityTiming=Object.freeze({
 inspectionFreshnessMs:30000,receiptFreshnessMs:30000,sourceProofFreshnessMs:30000,
 inspectionTimeoutMs:30000,nativeStartupTimeoutMs:120000,nativePreparationTimeoutMs:120000,
 nativePairingTimeoutMs:60000,nativeReadyTimeoutMs:60000,hostIdleTimeoutMs:120000,
 startupOverallTimeoutMs:120000,noProgressTimeoutMs:120000,cleanupTimeoutMs:120000,settlementTimeoutMs:60000,
 readRefreshTimeoutMs:30000,commandRoundTripTimeoutMs:120000,observationFreshnessMs:300000,planningTimeoutMs:120000,visionMaximumDurationMs:120000,visionIdleTimeoutMs:120000,visionSlotAttemptTimeoutMs:30000,
});
/** Trusted configuration only; no getters, coercion, wire-selected fields or TTL
 * authority caching. Small explicit limits are useful to test genuinely stuck IO. */
export function captureGameSanityTiming(input?:GameSanityTimingInput):GameSanityTiming{
 if(input===undefined)return GAME_SANITY_TIMING_DEFAULTS;
 if(!input||typeof input!=='object'||Array.isArray(input)||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('Game sanity timing unavailable');
 const result:{-readonly [K in keyof GameSanityTiming]:number}={...GAME_SANITY_TIMING_DEFAULTS};
 for(const key of Reflect.ownKeys(input)){
  if(typeof key!=='string'||!Object.hasOwn(maxima,key))throw Error('Game sanity timing unavailable');
  const descriptor=Object.getOwnPropertyDescriptor(input,key)!;
  if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='number'||!Number.isSafeInteger(descriptor.value)||descriptor.value<1||descriptor.value>maxima[key as keyof GameSanityTiming])throw Error('Game sanity timing unavailable');
  result[key as keyof GameSanityTiming]=descriptor.value;
 }
 return Object.freeze(result);
}
