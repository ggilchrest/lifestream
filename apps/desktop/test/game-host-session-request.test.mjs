import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const {createSessionBoundGameHostFetch}=createRequire(import.meta.url)('../game-host-session-request.cjs');
const origin='http://127.0.0.1:43182';
function fixture({body='{}',redirect=false}={}){const partition={},calls=[];let aborted=false;const net={request(options){calls.push(options);const request=new EventEmitter();request.abort=()=>{aborted=true;};request.end=()=>queueMicrotask(()=>{if(redirect){request.emit('redirect');return;}const response=new EventEmitter();response.headers={'content-type':'application/json','set-cookie':['SYNTHETIC_NOT_FORWARDED']};response.statusCode=200;request.emit('response',response);response.emit('data',Buffer.from(body));response.emit('end');});return request;}};return {fetch:createSessionBoundGameHostFetch(net,partition),calls,partition,get aborted(){return aborted;}};}
const init={method:'POST',body:'{}',credentials:'include',redirect:'error',cache:'no-store',headers:{'x-lifestream-csrf':'SYNTHETIC_FIXTURE',cookie:'IGNORED',authorization:'IGNORED'}};
test('session request fixes Origin and preserves the actual partition without exposing headers',async()=>{const f=fixture(),response=await f.fetch(origin+'/api/runtime/v1/game-host/next',init);assert.equal(f.calls[0].session,f.partition);assert.equal(f.calls[0].origin,origin);assert.equal(f.calls[0].credentials,'include');assert.equal(f.calls[0].bypassCustomProtocolHandlers,true);assert.deepEqual(Object.keys(f.calls[0].headers).sort(),['content-type','origin','x-lifestream-csrf']);assert.equal(response.headers.get('set-cookie'),null);assert.deepEqual(await response.json(),{});});
test('request adapter rejects routes, methods, cross origins and caller auth options before I/O',async()=>{const f=fixture();for(const url of [origin+'/api/auth/v1/accounts','http://example.org/api/runtime/v1/game-host/next',origin+'/api/runtime/v1/game-host/next?x=1'])await assert.rejects(f.fetch(url,init));await assert.rejects(f.fetch(origin+'/api/runtime/v1/game-host/next',{...init,redirect:'follow'}));assert.equal(f.calls.length,0);});
test('oversize and redirect responses abort instead of following or retaining them',async()=>{for(const options of [{body:'x'.repeat(131073)},{redirect:true}]){const f=fixture(options);await assert.rejects(f.fetch(origin+'/api/runtime/v1/game-host/next',init));assert.equal(f.aborted,true);}});
test('already aborted caller enters no request',async()=>{const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.fetch(origin+'/api/runtime/v1/game-host/next',{...init,signal:controller.signal}));assert.equal(f.calls.length,0);});


test('only the exact raw PNG route accepts bounded binary bytes; control and response limits remain unchanged',async()=>{
 const id='00000000-0000-4000-8000-000000000001',path=origin+'/api/runtime/v1/game-host/frame/'+[id,id,'a'.repeat(64),id].join('/'),f=fixture(),large={...init,body:Buffer.alloc(200000),headers:{...init.headers,'content-type':'image/png'}};
 await f.fetch(path,large);assert.equal(f.calls.length,1);assert.equal(f.calls[0].headers['content-type'],'image/png');
 await assert.rejects(f.fetch(origin+'/api/runtime/v1/game-host/next',large));await assert.rejects(f.fetch(path,{...large,body:Buffer.alloc(2097153)}));await assert.rejects(f.fetch(path,{...large,body:'not raw PNG'}));await assert.rejects(f.fetch(path+'/../arbitrary',large));assert.equal(f.calls.length,1);
 const oversized=fixture({body:'x'.repeat(131073)});await assert.rejects(oversized.fetch(path,{...large,body:Buffer.alloc(70)}));assert.equal(oversized.aborted,true);
});
