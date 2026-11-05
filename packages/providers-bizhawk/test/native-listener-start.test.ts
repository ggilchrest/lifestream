import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {startNativeListener} from '../src/native-listener-start.ts';
class Listener extends EventEmitter{
 listening=false;binds=0;closes=0;throwOnBind=false;
 listen(options:unknown){assert.deepEqual(options,{host:'127.0.0.1',port:43183,exclusive:true});this.binds++;if(this.throwOnBind)throw Error('Synthetic bind refusal');return this;}
 close(callback:()=>void){this.closes++;this.listening=false;callback();return this;}
 opened(){this.listening=true;this.emit('listening');}
}
test('cancellation during an unresolved native bind settles immediately and closes a late original listener',async()=>{
 const server=new Listener(),controller=new AbortController(),pending=startNativeListener(server as any,43183,controller.signal);assert.equal(server.binds,1);controller.abort();await assert.rejects(pending,/cancelled/);
 assert.equal(server.closes,1);server.opened();assert.equal(server.closes,2);assert.equal(server.listening,false);assert.equal(server.binds,1);
});
test('already cancelled setup makes no bind attempt',async()=>{
 const server=new Listener(),controller=new AbortController();controller.abort();await assert.rejects(startNativeListener(server as any,43183,controller.signal));assert.equal(server.binds,0);
});
test('close, error and synchronous bind failure all settle the exact original setup',async()=>{
 for(const mode of ['close','error','throw']){const server=new Listener(),controller=new AbortController();server.throwOnBind=mode==='throw';const pending=startNativeListener(server as any,43183,controller.signal);if(mode!=='throw')server.emit(mode,Error('Synthetic failure'));await assert.rejects(pending);assert.equal(server.binds,1);assert.equal(server.listening,false);}
});
test('successful listener setup removes only its original setup observers',async()=>{
 const server=new Listener(),controller=new AbortController(),pending=startNativeListener(server as any,43183,controller.signal);server.opened();await pending;assert.equal(server.listenerCount('listening'),0);assert.equal(server.listenerCount('close'),0);controller.abort();assert.equal(server.closes,0);
});
