import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createGameHostMenuActions}=require('../game-host-menu.cjs'),{gameHostFailure,gameHostBlockingReason}=require('../game-host-diagnostics.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({reason='audience_unavailable',dialogFails=false,destroyed=false,stopFails=false}={}){
 const events=[],logs=[],dialogs=[];let starts=0,stops=0,enabled=true,resolveDialog;
 const gate=new Promise(resolve=>{resolveDialog=resolve;});
 const gameHost={async readiness(){return {ready:false,blockingReason:reason};},async startApprovedSession(){starts++;events.push('start');throw gameHostFailure(reason);},async stop(){stops++;events.push('stop');enabled=false;if(stopFails)throw Error('PRIVATE_PROVIDER_EXCEPTION');},status(){return {enabled};}};
 const actions=createGameHostMenuActions({window:{isDestroyed:()=>destroyed},gameHost,dialog:{async showMessageBox(window,options){events.push('dialog');dialogs.push(options);if(dialogFails)throw Error('PRIVATE_DIALOG_EXCEPTION');await gate;return {response:0};}},log:value=>{events.push(value.kind);logs.push(value);},now:()=> '2026-10-03T04:00:00.000Z',setStartEnabled:value=>events.push('startEnabled:'+value)});
 return {actions,events,logs,dialogs,gameHost,resolveDialog,get starts(){return starts;},get stops(){return stops;}};
}
test('start rejection is recorded and stopped before an owned modal; pending modal cannot strand cleanup',async()=>{
 const f=fixture(),pending=f.actions.startApproved();await tick();
 assert.equal(f.starts,1);assert.equal(f.stops,1);assert.equal(f.gameHost.status().enabled,false);
 assert.ok(f.events.indexOf('gameHostStartRejected')<f.events.indexOf('stop'));assert.ok(f.events.indexOf('stop')<f.events.indexOf('dialog'));
 assert.equal(f.logs[0].blockingReason,'audience_unavailable');assert.match(f.dialogs[0].detail,/If you are alone/);assert.match(f.dialogs[0].detail,/restart clears/);
 assert.equal(f.actions.startApproved(),pending,'a second callback while the warning is open does not invoke Start again');
 await f.actions.stop();assert.equal(f.stops,2,'trusted Stop does not wait for modal dismissal');
 const readiness=await f.actions.report();assert.equal(readiness.ready,false);assert.equal(f.dialogs.length,1,'readiness does not stack a second modal');
 f.resolveDialog();assert.equal(await pending,null);assert.equal(f.logs.at(-1).kind,'gameHostDialogDismissed');
});
test('dismissal clears modal state and readiness reports the exact blocking reason',async()=>{
 const f=fixture();const start=f.actions.startApproved();await tick();f.resolveDialog();await start;
 await f.actions.report();assert.equal(f.dialogs.length,2);assert.equal(f.dialogs[1].message,'Native session is not ready.');assert.match(f.dialogs[1].detail,/Audience privacy is protected/);
 assert.equal(f.logs.find(log=>log.kind==='onDemandDesktopGameHostReadiness').blockingReason,'audience_unavailable');assert.equal(f.starts,1);
});
for(const mode of ['dialogFails','destroyed','stopFails'])test('failure UI '+mode+' preserves rejection evidence without leaking raw errors',async()=>{
 const f=fixture({[mode]:true});const pending=f.actions.startApproved();await tick();f.resolveDialog();await pending;
 assert.equal(f.logs[0].kind,'gameHostStartRejected');assert.equal(f.stops,1);assert.equal(JSON.stringify(f.logs).includes('PRIVATE_'),false);
 if(mode==='destroyed')assert.equal(f.dialogs.length,0);
 if(mode==='stopFails')assert.equal(f.logs.find(log=>log.kind==='gameHostStartCleanup').stopCompleted,false);
 if(mode==='dialogFails'){await f.actions.report();assert.equal(f.dialogs.length,2,'a failed dialog cannot strand the modal lock');}
});
test('arbitrary exceptions and hostile getters cannot export provider details as reason codes',()=>{
 assert.equal(gameHostBlockingReason(Error('PRIVATE_PROVIDER_EXCEPTION')),'native_start_failed');
 assert.equal(gameHostBlockingReason({code:'PRIVATE_SECRET'}),'native_start_failed');
 assert.equal(gameHostBlockingReason({get code(){throw Error('PRIVATE_SECRET');}}),'native_start_failed');
 let reads=0;assert.equal(gameHostBlockingReason({get code(){reads++;return reads===1?'audience_unavailable':'PRIVATE_SECRET';}}),'audience_unavailable');assert.equal(reads,1);
});
