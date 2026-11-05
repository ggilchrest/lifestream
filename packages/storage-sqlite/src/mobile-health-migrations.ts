import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {loadMigrations, type Migration} from './migrations/index.ts';

/** Explicit composition plan only. The default migration catalog is unchanged. */
export function loadHealthBasicMigrations(existing: readonly Migration[] = loadMigrations()): Migration[] {
  if (!Array.isArray(existing)) throw new Error('health_migration_plan_invalid');
  const plan = new Map<number, Migration>();
  for (const migration of existing) {
    if (!migration || !Number.isSafeInteger(migration.id) || migration.id < 1 ||
        typeof migration.name !== 'string' || !/^[a-z0-9_]+$/.test(migration.name) ||
        typeof migration.sql !== 'string' || typeof migration.digest !== 'string' ||
        migration.digest !== createHash('sha256').update(migration.sql).digest('hex') || plan.has(migration.id)) {
      throw new Error('health_migration_plan_invalid');
    }
    plan.set(migration.id, {...migration});
  }
  for (const [id, name, file] of [
    [84, 'mobile_context', '0084_mobile_context.sql'],
    [87, 'mobile_context_policy_decisions', '0087_mobile_context_policy_decisions.sql']
  ] as const) {
    const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
    const migration = {id, name, sql, digest: createHash('sha256').update(sql).digest('hex')};
    const prior = plan.get(id);
    if (prior && (prior.name !== name || prior.digest !== migration.digest || prior.sql !== sql)) {
      throw new Error(`health_migration_conflict_${id}`);
    }
    if (!prior) plan.set(id, migration);
  }
  return [...plan.values()].sort((a, b) => a.id - b.id);
}

/** Separate opt-in source-consent plan; the historical basic plan is unchanged. */
export function loadHealthConsentMigrations():Migration[]{
 const plan=loadHealthBasicMigrations(),sql=readFileSync(new URL('./migrations/0090_mobile_context_source_consent.sql',import.meta.url),'utf8');
 return [...plan,{id:90,name:'mobile_context_source_consent',sql,digest:createHash('sha256').update(sql).digest('hex')}];
}
export function assertHealthConsentMigrationInventory(database:import('./database.ts').Database):void{
 const objects=database.connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();if(!objects.length)return;
 if(!objects.some(r=>r.name==='schema_migrations'))throw Error('health_consent_inventory');
 const rows=database.connection.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all().map(r=>({...r}));
 const identity=(plan:readonly Migration[])=>JSON.stringify(plan.map(({id,name,digest})=>({id,name,digest})));
 if(![loadMigrations(),loadHealthBasicMigrations(),loadHealthConsentMigrations()].some(plan=>identity(plan)===JSON.stringify(rows)))throw Error('health_consent_inventory');
}
