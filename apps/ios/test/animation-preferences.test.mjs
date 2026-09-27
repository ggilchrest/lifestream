import test from 'node:test';
import assert from 'node:assert/strict';
import {animationChoices,animationKey,resolveAppearance} from '../web/animation-preferences.js';

test('all declared clips are offered and explicit replacement preserves disabled choices',()=>{
 const old={id:'sample',digest:'a'.repeat(64)},next={id:'sample',digest:'b'.repeat(64),manifest:{replaces:[old.digest],animationLibrary:[{clip:'idle',label:'Idle'},{clip:'wave',label:'Wave',group:'Movement'},{clip:'smile',label:'Smile',group:'Expression'}]}};
 const neutral={id:'neutral',digest:'neutral-v1'},catalog={neutral,packages:[next],defaultId:'sample'},disabled={[animationKey(old,'idle')]:true};
 assert.equal(animationChoices(next).length,3);assert.deepEqual(resolveAppearance(catalog,old,disabled),{item:next,migrated:true});assert.equal(disabled[animationKey(next,'idle')],true);assert.equal(disabled[animationKey(old,'idle')],undefined);assert.equal(disabled[animationKey(next,'wave')],undefined);
 assert.deepEqual(resolveAppearance(catalog,{id:'sample',digest:'c'.repeat(64)},disabled),{item:null,migrated:false});assert.deepEqual(resolveAppearance(catalog,next,disabled),{item:next,migrated:false});assert.equal(resolveAppearance(catalog,null,disabled).item,next);
});

test('older packages retain their semantic toggles without offering the speech amplitude overlay',()=>{
 assert.deepEqual(animationChoices({manifest:{animations:{idle:'idle',listening:'idle',speaking:'talk',mouthAmplitude:'mouth'}}}),[{clip:'idle',label:'Idle / Listening'},{clip:'talk',label:'Speaking'}]);
});
