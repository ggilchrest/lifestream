import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {loadMigrations, type Migration} from './migrations/index.ts';
import {loadHealthConsentMigrations} from './mobile-health-migrations.ts';
import {loadCalendarBasicMigrations} from './mobile-calendar-migrations.ts';
import type {Database} from './database.ts';

/** Separately selected metadata capability; historical plans remain strict. */
export function loadMobileSourceControlMigrations():Migration[]{
 const sql=readFileSync(new URL('./migrations/0085_mobile_context_interpretation.sql',import.meta.url),'utf8');
 const digest=createHash('sha256').update(sql).digest('hex');
 if(digest!=='8701cc4499d774eddf289c27856a423f739c695707926737e14c0e804245f826')throw Error('mobile_source_control_sql');
 return [...loadCalendarBasicMigrations(true,true),{id:85,name:'mobile_context_interpretation',sql,digest}].sort((a,b)=>a.id-b.id);
}
export function assertMobileSourceControlMigrationInventory(database:Database):void{
 const objects=database.connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
 if(!objects.length)return;
 if(!objects.some(r=>r.name==='schema_migrations'))throw Error('mobile_source_control_inventory');
 const rows=database.connection.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all().map(r=>({...r}));
 if(!rows.length&&objects.every(r=>r.name==='schema_migrations'))return;
 const identity=(plan:readonly Migration[])=>JSON.stringify(plan.map(({id,name,digest})=>({id,name,digest})));
 if(![loadMigrations(),loadHealthConsentMigrations(),loadCalendarBasicMigrations(true,true),loadMobileSourceControlMigrations()].some(plan=>identity(plan)===JSON.stringify(rows)))throw Error('mobile_source_control_inventory');
}
