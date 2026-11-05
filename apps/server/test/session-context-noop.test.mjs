import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database} from '@lifestream/storage-sqlite';
import {reviseSessionEndpoint,readSessionEndpoint} from '../src/runtime/session-context.ts';
import test from 'node:test';
test('unchanged saves preserve scope; real configuration changes retain revision fences',()=>{
const db=new Database({path:':memory:'});db.migrate();
const sessionId=randomUUID(),principalId=randomUUID(),bindingKey=randomUUID();
try{
 const first=reviseSessionEndpoint(db,sessionId,{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey},true,principalId);
 const before=db.connection.prepare('SELECT profile_json FROM interaction_endpoints WHERE endpoint_id=?').get(first.endpoint.endpointId).profile_json;
 const saved=reviseSessionEndpoint(db,sessionId,{expectedRevision:first.revision,mode:'text',audienceScope:'authenticatedSession',bindingKey},true,principalId);
 assert.deepEqual(saved,first);assert.equal(db.connection.prepare('SELECT profile_json FROM interaction_endpoints WHERE endpoint_id=?').get(first.endpoint.endpointId).profile_json,before);
 assert.throws(()=>reviseSessionEndpoint(db,sessionId,{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey},true,principalId),/revision conflict/);
 const audio=reviseSessionEndpoint(db,sessionId,{expectedRevision:saved.revision,mode:'audio',audienceScope:'authenticatedSession',bindingKey},true,principalId);assert.equal(audio.revision,saved.revision+1);assert.equal(audio.endpoint.configurationRevision,saved.endpoint.configurationRevision+1);
 const withheld=reviseSessionEndpoint(db,sessionId,{expectedRevision:audio.revision,mode:'audio',audienceScope:'unknown',bindingKey},true,principalId);assert.equal(withheld.revision,audio.revision+1);assert.equal(withheld.endpoint.privacyClass,'public');
 // Another authenticated session's newer physical endpoint revision must not be
 // mistaken for a no-op in this older session projection.
 const other=reviseSessionEndpoint(db,randomUUID(),{expectedRevision:0,mode:'audio',audienceScope:'unknown',bindingKey},true,principalId);
 const reconciled=reviseSessionEndpoint(db,sessionId,{expectedRevision:withheld.revision,mode:'audio',audienceScope:'unknown',bindingKey},true,principalId);assert.equal(reconciled.revision,withheld.revision+1);assert.equal(reconciled.endpoint.configurationRevision,other.endpoint.configurationRevision+1);
 assert.throws(()=>reviseSessionEndpoint(db,sessionId,{expectedRevision:reconciled.revision,mode:'text',audienceScope:'unknown',bindingKey,endpointClass:'personalCompanion'},true,principalId),/class cannot change/);
 assert.deepEqual(readSessionEndpoint(db,sessionId),reconciled);
 console.log(JSON.stringify({status:'PASS',checks:6,unchangedSavePreservesEndpointAndSession:true,genuineModePrivacyAndForeignRevisionStillRevise:true,staleCASAndForeignClassRefused:true,originalStateRead:false}));
}finally{db.close();}

});
