import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Database} from '@lifestream/storage-sqlite';
import type {LocalContext} from '../src/auth/local-auth.ts';
import {ConversationHistory} from '../src/runtime/conversation.ts';
import {AuthenticatedSessionHandoff,type HandoffScope} from '../src/runtime/session-handoff.ts';

test('idle prepared dialogue is erased at its original earliest expiry, leaving only bounded review metadata',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=1000;const database=new Database({path:':memory:'});database.migrate();t.after(()=>database.close());const history=new ConversationHistory(()=>now);t.after(()=>history.clear());
 const principalId=randomUUID(),assistantId=randomUUID(),sourceId=randomUUID(),destinationId=randomUUID(),conversationId=randomUUID(),context=(sessionId:string):LocalContext=>({principalId,sessionId,owner:true,origin:'http://localhost',authenticatedAt:0,expiresAt:new Date(1000000).toISOString(),tokenHash:'a'.repeat(64)});
 const scopes=new Map<string,HandoffScope>([sourceId,destinationId].map(sessionId=>[sessionId,{scope:{principalId,sessionId,assistantId,conversationId:sessionId===sourceId?conversationId:randomUUID(),relationshipId:null},endpointId:randomUUID(),revision:1,mode:'message',current:()=>true,dialogueCurrent:()=>true}]));
 history.bind(scopes.get(sourceId)!.scope,()=>true,1100).remember({interactionId:randomUUID(),role:'user',text:'SYNTHETIC_EXPIRING_HANDOFF_PAYLOAD'});
 const service=new AuthenticatedSessionHandoff({database,history,environmentId:randomUUID(),scope:c=>scopes.get(c.sessionId)!,busy:()=>false,authorized:()=>true,now:()=>now});t.after(()=>service.close());const ready=service.receive(context(destinationId),assistantId),review=service.prepare(context(sourceId),assistantId,undefined,ready.readinessId);
 assert.equal(Date.parse(review.expiresAt),1100);assert.ok((service as any).plans.get(review.reviewId).dialogue);now=1100;t.mock.timers.tick(100);assert.equal((service as any).plans.get(review.reviewId).dialogue,undefined,'expiry erases copied raw text without another request');assert.equal(history.diagnostics().entries,0);
 now+=120000;t.mock.timers.tick(120000);assert.equal((service as any).plans.size,0);
});
