import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Database} from './database.ts';
import {loadMigrations, type Migration} from './migrations/index.ts';

const additions = [
  [84, 'mobile_context', '0084_mobile_context.sql'],
  [86, 'mobile_context_calendar', '0086_mobile_context_calendar.sql'],
  [89, 'mobile_context_calendar_settings', '0089_mobile_context_calendar_settings.sql']
] as const;

/** Explicit opt-in only; the default catalog and historical SQL stay unchanged. */
export function loadCalendarBasicMigrations(policy=false,consent=false): Migration[] {
  if(consent&&!policy)throw Error('calendar_consent_policy_required');
  return [...loadMigrations(), ...[...additions,...(consent?[[90,'mobile_context_source_consent','0090_mobile_context_source_consent.sql'] as const]:[]),...(policy?[[87,'mobile_context_policy_decisions','0087_mobile_context_policy_decisions.sql'] as const]:[])].sort((a,b)=>a[0]-b[0]).map(([id, name, file]) => {
    const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
    return {id, name, sql, digest: createHash('sha256').update(sql).digest('hex')};
  })];
}

/** Refuse unknown/partial inventories before constructor or candidate migration.
 * Full DDL/cohort admission remains the prepared package's exact schema check. */
export function assertCalendarMigrationInventory(database: Database,policy=false,consent=false): void {
  const connection = database.connection;
  const objects = connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  if (!objects.length) return;
  if (!objects.some(row => row.name === 'schema_migrations')) throw Error('calendar_migration_inventory');
  const actual = connection.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all();
  if (!actual.length && objects.every(row => row.name === 'schema_migrations')) return;
  const identity = (rows: readonly {id:number;name:string;digest:string}[]) => JSON.stringify(rows.map(({id,name,digest}) => ({id,name,digest})));
  const plan = loadCalendarBasicMigrations(policy,consent), base = loadMigrations();
  if (![identity(base), identity(plan),...(policy?[identity(loadCalendarBasicMigrations())]:[]),...(consent?[identity(loadCalendarBasicMigrations(true))]:[])].includes(JSON.stringify(actual))) throw Error('calendar_migration_inventory');
}
