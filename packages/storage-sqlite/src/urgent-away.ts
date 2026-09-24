import {randomUUID} from 'node:crypto';
import type {Database, Transaction} from './database.ts';
import {urgentAttentionScopeKey, type UrgentAttentionScope, type UrgentAttentionSettings} from './urgent-attention.ts';

export type UrgentAwayState = 'reserved' | 'attempted' | 'accepted' | 'denied' | 'approvalRequired' | 'failed' | 'unknown' | 'cancelled';
export type UrgentAwayReason = 'admission_denied' | 'admission_uncertain' | 'approval_required' | 'capability_unavailable' | 'destination_unavailable' |
  'binding_changed' | 'scope_changed' | 'condition_changed' | 'expired' | 'delivery_contract_invalid' |
  'provider_accepted' | 'provider_denied' | 'provider_failed' | 'provider_unknown' | 'consumer_restarted' | 'restore_quarantine' | 'cancelled';
/** Only opaque identity, exact binding digests and typed outcomes belong in this ledger. */
export type UrgentAwayInput = {
  scope: UrgentAttentionScope;
  destinationRef: string;
  destinationRevision: number;
  conditionRef: string;
  conditionRevision: number;
  sourceRef: string;
  eventClass: string;
  capabilityId: string;
  capabilityVersion: string;
  capabilityRoute: string;
  capabilityScopeDigest: string;
  invocationId: string;
  inputDigest: string;
  expiresAt: string;
};
export type UrgentAwayOutcome = {
  state: Exclude<UrgentAwayState, 'reserved' | 'attempted'>;
  reason: UrgentAwayReason;
  receiptDigest?: string;
};
export type UrgentAwayDestinationBinding = {bindingDigest: string; boundAt: string};
export type UrgentAwayRecord = UrgentAwayInput & {
  id: string;
  revision: number;
  state: UrgentAwayState;
  reason: UrgentAwayReason | null;
  receiptDigest: string | null;
  createdAt: string;
  updatedAt: string;
  attemptedAt: string | null;
  acceptedAt: string | null;
  acknowledgedAt: string | null;
};
export class UrgentAwayError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'UrgentAwayError'; this.code = code; }
}
const fail = (code: string): never => { throw new UrgentAwayError(code); };
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const reasons: readonly UrgentAwayReason[] = ['admission_denied', 'admission_uncertain', 'approval_required', 'capability_unavailable', 'destination_unavailable',
  'binding_changed', 'scope_changed', 'condition_changed', 'expired', 'delivery_contract_invalid', 'provider_accepted', 'provider_denied',
  'provider_failed', 'provider_unknown', 'consumer_restarted', 'restore_quarantine', 'cancelled'];
const states: readonly UrgentAwayState[] = ['accepted', 'denied', 'approvalRequired', 'failed', 'unknown', 'cancelled'];
const inputKeys = ['scope', 'destinationRef', 'destinationRevision', 'conditionRef', 'conditionRevision', 'sourceRef', 'eventClass',
  'capabilityId', 'capabilityVersion', 'capabilityRoute', 'capabilityScopeDigest', 'invocationId', 'inputDigest', 'expiresAt'].sort();
type Row = {record_json: string};
const decode = (row: Row | undefined): UrgentAwayRecord | undefined => row ? JSON.parse(row.record_json) as UrgentAwayRecord : undefined;
const pending = (state: UrgentAwayState) => state === 'reserved' || state === 'attempted';

function checkedInput(value: UrgentAwayInput): UrgentAwayInput {
  if (!value || Object.keys(value).sort().join(',') !== inputKeys.join(',') ||
      ![value.destinationRef, value.conditionRef, value.sourceRef, value.eventClass, value.capabilityId, value.capabilityVersion,
        value.capabilityRoute, value.invocationId].every(identifier) || !revision(value.destinationRevision) || !revision(value.conditionRevision) ||
      !digest(value.capabilityScopeDigest) || !digest(value.inputDigest) || !timestamp(value.expiresAt)) return fail('invalid_away_input');
  urgentAttentionScopeKey(value.scope);
  return structuredClone(value);
}
function sameBinding(a: UrgentAwayInput, b: UrgentAwayInput): boolean {
  return inputKeys.every(key => key === 'scope' ? urgentAttentionScopeKey(a.scope) === urgentAttentionScopeKey(b.scope) :
    a[key as keyof UrgentAwayInput] === b[key as keyof UrgentAwayInput]);
}

/** No pruning: losing an episode tombstone could authorize a second effect.
 * Capacity exhaustion denies new reservations while preserving existing history. */
export class UrgentAwayRepository {
  readonly database: Database;
  private readonly maximumRecords: number;
  constructor(database: Database, maximumRecords = 4096) {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 65536) fail('invalid_away_capacity');
    this.database = database;
    this.maximumRecords = maximumRecords;
  }
  private transaction<T>(operation: (tx: Transaction) => T): T {
    // A committed attempt must survive a crash before the external invocation.
    // This setting is connection-local and restored before returning to callers.
    const previous = Number(this.database.connection.prepare('PRAGMA synchronous').get()!.synchronous);
    if (previous < 2) this.database.connection.exec('PRAGMA synchronous=FULL');
    try { return this.database.transaction(operation); }
    finally { if (previous < 2) this.database.connection.exec(`PRAGMA synchronous=${previous}`); }
  }
  private save(tx: Transaction, record: UrgentAwayRecord): void {
    tx.run('UPDATE urgent_away_dispatches SET revision=?,state=?,updated_at=?,record_json=? WHERE dispatch_id=?',
      record.revision, record.state, record.updatedAt, JSON.stringify(record), record.id);
  }
  destinationBinding(scope: UrgentAttentionScope): UrgentAwayDestinationBinding | undefined {
    return this.database.connection.prepare('SELECT binding_digest AS bindingDigest,bound_at AS boundAt FROM urgent_away_destination_bindings WHERE scope_key=?')
      .get(urgentAttentionScopeKey(scope)) as UrgentAwayDestinationBinding | undefined;
  }
  /** The caller first disables the shared policy, then records the new binding.
   * An interruption between these operations leaves a disabled destination. */
  bindDestination(scope: UrgentAttentionScope, bindingDigest: string, now: string): UrgentAwayDestinationBinding {
    const key = urgentAttentionScopeKey(scope);
    if (!digest(bindingDigest) || !timestamp(now)) return fail('invalid_away_binding');
    return this.transaction(tx => {
      const previous = tx.get<UrgentAwayDestinationBinding>('SELECT binding_digest AS bindingDigest,bound_at AS boundAt FROM urgent_away_destination_bindings WHERE scope_key=?', key);
      if (previous?.bindingDigest === bindingDigest) return previous;
      if (previous && Date.parse(now) < Date.parse(previous.boundAt)) return fail('away_clock_regressed');
      const row = tx.get<{settings_json: string}>('SELECT settings_json FROM urgent_attention_settings WHERE scope_key=?', key);
      const settings = row ? JSON.parse(row.settings_json) as UrgentAttentionSettings : undefined;
      if (settings && (settings.rules.some(rule => rule.enabled || rule.bypassQuietHours) || settings.snoozedUntil !== null)) return fail('away_binding_requires_disabled');
      if (!previous && Number(tx.get<{count: number}>('SELECT count(*) AS count FROM urgent_away_destination_bindings')!.count) >= this.maximumRecords) return fail('away_capacity_exhausted');
      tx.run('INSERT INTO urgent_away_destination_bindings VALUES (?,?,?) ON CONFLICT(scope_key) DO UPDATE SET binding_digest=excluded.binding_digest,bound_at=excluded.bound_at', key, bindingDigest, now);
      return {bindingDigest, boundAt: now};
    });
  }
  private mutate(id: string, expectedRevision: number, now: string, operation: (record: UrgentAwayRecord) => void): UrgentAwayRecord {
    if (!identifier(id) || !revision(expectedRevision) || !timestamp(now)) return fail('invalid_away_mutation');
    return this.transaction(tx => {
      const record = decode(tx.get<Row>('SELECT record_json FROM urgent_away_dispatches WHERE dispatch_id=?', id));
      if (!record) return fail('away_dispatch_not_found');
      if (record.revision !== expectedRevision) return fail('away_revision_conflict');
      if (Date.parse(now) < Date.parse(record.updatedAt)) return fail('away_clock_regressed');
      operation(record);
      record.revision++;
      record.updatedAt = now;
      this.save(tx, record);
      return record;
    });
  }
  reserve(input: UrgentAwayInput, now: string): {record: UrgentAwayRecord; created: boolean} {
    input = checkedInput(input);
    if (!timestamp(now)) return fail('invalid_away_time');
    const key = urgentAttentionScopeKey(input.scope);
    return this.transaction(tx => {
      const previous = decode(tx.get<Row>('SELECT record_json FROM urgent_away_dispatches WHERE scope_key=? AND destination_ref=? AND condition_ref=?',
        key, input.destinationRef, input.conditionRef));
      if (previous) {
        if (!sameBinding(previous, input)) return fail('away_binding_conflict');
        return {record: previous, created: false};
      }
      if (Date.parse(input.expiresAt) <= Date.parse(now)) return fail('away_dispatch_expired');
      if (tx.get('SELECT dispatch_id FROM urgent_away_dispatches WHERE invocation_id=?', input.invocationId)) return fail('away_invocation_conflict');
      if (Number(tx.get<{count: number}>('SELECT count(*) AS count FROM urgent_away_dispatches')!.count) >= this.maximumRecords) return fail('away_capacity_exhausted');
      const record: UrgentAwayRecord = {...input, id: randomUUID(), revision: 1, state: 'reserved', reason: null,
        receiptDigest: null, createdAt: now, updatedAt: now, attemptedAt: null, acceptedAt: null, acknowledgedAt: null};
      tx.run('INSERT INTO urgent_away_dispatches VALUES (?,?,?,?,?,?,?,?,?)', record.id, key, input.destinationRef, input.conditionRef,
        input.invocationId, record.revision, record.state, now, JSON.stringify(record));
      return {record, created: true};
    });
  }
  get(id: string): UrgentAwayRecord | undefined {
    if (!identifier(id)) return fail('invalid_away_identity');
    return decode(this.database.connection.prepare('SELECT record_json FROM urgent_away_dispatches WHERE dispatch_id=?').get(id) as Row | undefined);
  }
  find(scope: UrgentAttentionScope, destinationRef: string, conditionRef: string): UrgentAwayRecord | undefined {
    if (![destinationRef, conditionRef].every(identifier)) return fail('invalid_away_identity');
    return decode(this.database.connection.prepare('SELECT record_json FROM urgent_away_dispatches WHERE scope_key=? AND destination_ref=? AND condition_ref=?')
      .get(urgentAttentionScopeKey(scope), destinationRef, conditionRef) as Row | undefined);
  }
  inspect(scope: UrgentAttentionScope): UrgentAwayRecord[] {
    return (this.database.connection.prepare('SELECT record_json FROM urgent_away_dispatches WHERE scope_key=? ORDER BY updated_at DESC,dispatch_id LIMIT 100')
      .all(urgentAttentionScopeKey(scope)) as Row[]).map(row => decode(row)!);
  }
  markAttempted(id: string, expectedRevision: number, now: string): UrgentAwayRecord {
    return this.mutate(id, expectedRevision, now, record => {
      if (record.state !== 'reserved') return fail('invalid_away_transition');
      if (Date.parse(record.expiresAt) <= Date.parse(now)) return fail('away_dispatch_expired');
      record.state = 'attempted';
      record.attemptedAt = now;
    });
  }
  settle(id: string, expectedRevision: number, outcome: UrgentAwayOutcome, now: string): UrgentAwayRecord {
    if (!outcome || Object.keys(outcome).some(key => !['state', 'reason', 'receiptDigest'].includes(key)) ||
        !states.includes(outcome.state) || !reasons.includes(outcome.reason) || outcome.receiptDigest !== undefined && !digest(outcome.receiptDigest)) return fail('invalid_away_outcome');
    return this.mutate(id, expectedRevision, now, record => {
      // Late revocation can retire an accepted/unknown delivery, preserving its observed history.
      if (!pending(record.state) && !(outcome.state === 'cancelled' && ['accepted', 'unknown'].includes(record.state))) return fail('invalid_away_transition');
      const uncertainAdmission = outcome.state === 'unknown' && outcome.reason === 'admission_uncertain' && record.state === 'reserved' && record.attemptedAt === null;
      if (outcome.reason === 'admission_uncertain' && !uncertainAdmission) return fail('invalid_away_outcome');
      if (['accepted', 'unknown'].includes(outcome.state) && record.state !== 'attempted' && !uncertainAdmission) return fail('invalid_away_transition');
      if (outcome.state === 'accepted' && outcome.reason !== 'provider_accepted') return fail('invalid_away_outcome');
      if (outcome.receiptDigest !== undefined && record.attemptedAt === null) return fail('invalid_away_outcome');
      if (record.receiptDigest !== null && outcome.receiptDigest !== undefined && outcome.receiptDigest !== record.receiptDigest) return fail('away_receipt_conflict');
      record.state = outcome.state;
      record.reason = outcome.reason;
      if (outcome.receiptDigest !== undefined) record.receiptDigest = outcome.receiptDigest;
      if (outcome.state === 'accepted') record.acceptedAt = now;
    });
  }
  acknowledge(scope: UrgentAttentionScope, id: string, expectedRevision: number, now: string): UrgentAwayRecord {
    const key = urgentAttentionScopeKey(scope);
    return this.mutate(id, expectedRevision, now, record => {
      if (urgentAttentionScopeKey(record.scope) !== key) return fail('away_dispatch_not_found');
      if (record.acknowledgedAt !== null) return fail('away_already_acknowledged');
      record.acknowledgedAt = now;
    });
  }
  private retire(reason: 'consumer_restarted' | 'restore_quarantine', now: string, scopes?: UrgentAwayInput['scope'][]): UrgentAwayRecord[] {
    if (!timestamp(now)) return fail('invalid_away_time');
    const selected=scopes?new Set(scopes.map(urgentAttentionScopeKey)):undefined;
    return this.transaction(tx => {
      const changed: UrgentAwayRecord[] = [];
      for (const row of tx.all<Row>("SELECT record_json FROM urgent_away_dispatches WHERE state IN ('reserved','attempted')")) {
        const record = decode(row)!;
        if(selected&&!selected.has(urgentAttentionScopeKey(record.scope)))continue;
        record.state = record.attemptedAt === null ? 'cancelled' : 'unknown';
        record.reason = reason;
        record.revision++;
        // A clock rollback must not prevent startup from fencing unfinished effects.
        record.updatedAt = Date.parse(now) < Date.parse(record.updatedAt) ? record.updatedAt : now;
        this.save(tx, record);
        changed.push(record);
      }
      return changed;
    });
  }
  recover(now: string, scopes?: UrgentAwayInput['scope'][]): UrgentAwayRecord[] { return this.retire('consumer_restarted', now, scopes); }
  quarantine(now: string): UrgentAwayRecord[] { return this.retire('restore_quarantine', now); }
}
