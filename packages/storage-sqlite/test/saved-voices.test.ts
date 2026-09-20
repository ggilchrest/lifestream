import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {SavedVoiceRepository} from '../src/saved-voices.ts';
test('saved voice definitions and scoped expiring preview receipts survive restart',t=>{
 const root=mkdtempSync(join(tmpdir(),'saved-voice-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'state.sqlite');let db=new Database({path});db.migrate();let repo=new SavedVoiceRepository(db);
 const input={assistantId:'assistant',label:'Synthetic',language:'en',settings:{description:'Synthetic description'},providerBinding:'binding',createdAt:new Date().toISOString()},a=repo.create(input),b=repo.create({...input,label:'Alternative'});assert.equal(b.revision,2);assert.equal(repo.get('other',a.voiceRef),undefined);
 const scope={voiceRef:a.voiceRef,principalId:'owner',sessionId:'session',providerBinding:'binding'},at=new Date('2026-01-01T00:00:00Z'),previewId=repo.recordPreview(scope,at);db.close();db=new Database({path});t.after(()=>db.close());db.migrate();repo=new SavedVoiceRepository(db);assert.equal(repo.list('assistant').length,2);assert.equal(repo.reviewed({...scope,previewId},new Date(at.getTime()+1000)),true);for(const change of [{principalId:'other'},{sessionId:'other'},{providerBinding:'changed'},{voiceRef:b.voiceRef}])assert.equal(repo.reviewed({...scope,previewId,...change},at),false);assert.equal(repo.reviewed({...scope,previewId},new Date(at.getTime()+1800000)),false);
});
