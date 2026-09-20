import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {reviseSessionEndpoint} from '../src/runtime/session-context.ts';
import {PresentationPackages,PresentationSelection} from '../src/admin/presentation-packages.ts';
test('logical endpoint defaults survive sign-in while session overrides and audience declarations do not',t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const key=randomUUID(),input={expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:key};
 const first=reviseSessionEndpoint(db,'session1',input,false,'owner'),selection=new PresentationSelection(db);const catalog=new PresentationPackages();selection.select('owner',first.endpoint!.endpointId,'session1',{scope:'default',id:'neutral',digest:'neutral-v1',expectedRevision:0},catalog);selection.select('owner',first.endpoint!.endpointId,'session1',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0},catalog);
 const next=reviseSessionEndpoint(db,'session2',{...input,audienceScope:'unknown'},false,'owner');assert.equal(next.endpoint!.endpointId,first.endpoint!.endpointId);assert.equal(next.endpoint!.privacyClass,'public');assert.ok(selection.read('owner',next.endpoint!.endpointId,'session2').default);assert.equal(selection.read('owner',next.endpoint!.endpointId,'session2').override,null);
 const other=reviseSessionEndpoint(db,'session3',input,false,'other');assert.notEqual(other.endpoint!.endpointId,first.endpoint!.endpointId);assert.throws(()=>reviseSessionEndpoint(db,'session4',{...input,bindingKey:'../not-a-binding'},false,'owner'));
});
