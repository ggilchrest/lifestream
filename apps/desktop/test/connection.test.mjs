import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {endpointFromArguments,connectionPage}=createRequire(import.meta.url)('../connection-status.cjs');
test('packaged and development entrypoints select the same explicit loopback endpoint',()=>{
 const url='http://127.0.0.1:43199/control/#account';
 assert.equal(endpointFromArguments(['app','--url',url],true).endpoint.href,url);
 assert.equal(endpointFromArguments(['electron','main.cjs','--url',url],false).endpoint.href,url);
 assert.equal(endpointFromArguments(['app'],true).endpoint.origin,'http://127.0.0.1:43182');
 for(const value of ['https://127.0.0.1:43182/control/','http://example.com:43182/control/','http://u:p@localhost:43182/control/','http://localhost:43182/other/','http://localhost:43182/control/?token=x',undefined])assert.throws(()=>endpointFromArguments(['app','--url',value],true));
});
test('offline page has a same-endpoint retry and safely renders a hostile fragment without scripts',()=>{
 const {endpoint}=endpointFromArguments(['app','--url','http://localhost:43182/control/#<img src=x onerror=alert(1)>'],true),html=decodeURIComponent(connectionPage(endpoint).split(',').slice(1).join(','));
 assert.ok(html.includes('Retry connection'));
 assert.ok(html.includes("default-src 'none'"));
 assert.ok(!html.includes('<script'));
 assert.ok(!html.includes('<img'));
 assert.match(html,/href="http:\/\/localhost:43182\/control\/#/);
 assert.equal((html.match(/<a /g)||[]).length,1);
});
