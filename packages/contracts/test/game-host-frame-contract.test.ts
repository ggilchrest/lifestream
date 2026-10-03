import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseGameHostFramePath,gameHostFramePath,gameHostFrameAccepted,gameHostMessage,gameHostDigest,GAME_HOST_FRAME_LIMITS} from '../src/game-host.ts';
import {frameFixture} from '../../providers-bizhawk/test/game-host-frame-fixtures.ts';
import {action} from '../../providers-bizhawk/test/game-host-fixtures.ts';
test('raw PNG path binds only exact admitted-observe identifiers, not arbitrary paths or destinations',()=>{
 const f=frameFixture(),mediaRef=f.result.outcome.payload!.observation.screenshots[0]!.mediaRef,path=gameHostFramePath(f.command,mediaRef);assert.deepEqual(parseGameHostFramePath(path),{attachmentId:f.command.attachmentId,commandId:f.command.commandId,requestDigest:f.command.requestDigest,mediaRef});assert.ok(Object.isFrozen(parseGameHostFramePath(path)));
 for(const invalid of ['file:///C:/unrelated',path+'?file=C:/x',path+'#x',path+'/more',path.replace(mediaRef,'..'),path.replace(mediaRef,encodeURIComponent('C:/x')),path.replace(f.command.requestDigest,'x'),path.replace('/frame/','/result/')])assert.equal(parseGameHostFramePath(invalid),null,invalid);
 const request=action(),command={...f.command,request,requestDigest:gameHostDigest(request)};assert.throws(()=>gameHostFramePath(command,mediaRef));assert.throws(()=>gameHostFramePath(f.command,'../other'));
});
test('raw custody opt-in leaves normal control byte limits unchanged and accepts only closed acknowledgments',()=>{
 assert.equal(GAME_HOST_FRAME_LIMITS.pngBytes,2097152);const f=frameFixture();assert.equal(gameHostMessage('next',{protocol:f.attach.protocol,attachmentId:f.command.attachmentId,extra:'x'.repeat(131072)}),null);
 assert.equal(gameHostFrameAccepted({accepted:true}),true);for(const invalid of [{accepted:false},{accepted:'true'},{accepted:true,path:'other'},[true],null])assert.equal(gameHostFrameAccepted(invalid),false);
 let executed=false;const getter={};Object.defineProperty(getter,'accepted',{enumerable:true,get(){executed=true;return true;}});assert.equal(gameHostFrameAccepted(getter),false);assert.equal(executed,false);
});
