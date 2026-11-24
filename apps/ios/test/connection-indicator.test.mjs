import test from 'node:test';import assert from 'node:assert/strict';
import {createConnectionIndicator} from '../web/connection-indicator.js';
const snapshot=(revision,state,reason)=>({schemaVersion:'1.0.0',revision,state,reason});
function fixture(){const root={dataset:{},title:''},label={textContent:''};return {root,label,ui:createConnectionIndicator(root,label)}}
test('RAG maps only the closed Native connection/session observations with non-color text',()=>{
 const {ui,root,label}=fixture();assert.equal(root.dataset.state,'disconnected');
 for(const [revision,state,reason,text] of [[1,'disconnected','unconfigured','not configured'],[2,'disconnected','signed_out','signed out'],[3,'checking','connecting','connecting'],[4,'checking','restoring','restoring'],[5,'connected','verified','recently verified'],[6,'disconnected','network_unavailable','lost'],[7,'checking','connecting','connecting'],[8,'connected','verified','connected'],[9,'disconnected','authentication_required','sign in required'],[10,'disconnected','signed_out','signed out'],[11,'checking','verification_expired','fresh verification'],[12,'checking','unverified','status unavailable']]){assert.equal(ui.update(snapshot(revision,state,reason)),true);assert.equal(root.dataset.state,state);assert.ok(label.textContent.includes(text));assert.equal(root.title,label.textContent)}
});
test('Late snapshots cannot overwrite newer Native events and invalid metadata cannot invent green',()=>{
 const {ui,root}=fixture();ui.update(snapshot(8,'disconnected','signed_out'));assert.equal(ui.update(snapshot(7,'connected','verified')),false);assert.equal(root.dataset.state,'disconnected');
 for(const bad of [snapshot(9,'connected','network_unavailable'),{...snapshot(9,'connected','verified'),password:'SENTINEL'},snapshot(-1,'connected','verified'),snapshot(9,'playing','verified')]){assert.equal(ui.update(bad),false);assert.equal(root.dataset.state,'disconnected')}
});
test('A missing Native signal stays visibly unknown instead of trusting settings or microphone state',()=>{
 const {ui,root,label}=fixture();ui.unavailable();assert.equal(root.dataset.state,'checking');assert.match(label.textContent,/status unavailable/);assert.equal(ui.update({hasSession:true,endpoint:'https://saved.invalid',active:true,privateAllowed:true}),false);assert.equal(root.dataset.state,'checking')
});
