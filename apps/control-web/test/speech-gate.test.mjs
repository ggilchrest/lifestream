import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechGate} from '../speech-gate.js';
test('probability gate rejects low confidence and transient positive evidence',()=>{const gate=new SpeechGate(50);for(let i=0;i<30;i++)assert.equal(gate.update(.2,32),false);assert.equal(gate.update(.99,32),false);assert.equal(gate.update(.1,32),false);for(let i=0;i<6;i++)assert.equal(gate.update(.8,32),false);assert.equal(gate.update(.8,32),true);});
test('qualified barge-in has a separate faster onset and configuration resets evidence',()=>{const gate=new SpeechGate(50);for(let i=0;i<4;i++)assert.equal(gate.update(.8,32,true),false);assert.equal(gate.update(.8,32,true),true);gate.configure(0);assert.equal(gate.aboveMs,0);assert.equal(gate.update(.7,1000),false);gate.configure(100);for(let i=0;i<4;i++)assert.equal(gate.update(.5,32),false);assert.equal(gate.update(.5,32),true);});
