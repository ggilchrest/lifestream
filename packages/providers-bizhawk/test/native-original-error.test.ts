import test from 'node:test';
import assert from 'node:assert/strict';
import {captureNativeOriginalError} from '../src/native-original-error.ts';
function data(message:string,extra:Record<string,unknown>={}){return Object.assign(Object.create(Error.prototype),{message,stack:'Error: '+message+'\n at nativeOwner (fixture:1:1)',...extra});}
test('known fixed native messages retain original text and original code/signal/killed with bounded private cause',()=>{
 for(const message of ['Native inspection owner unavailable','Native command unavailable','Native GUI/source or wake preparation unavailable'])assert.equal(captureNativeOriginalError(data(message)).message,message);
 const cause=data('Native inspection read timed out',{code:'ETIMEDOUT',signal:'SIGTERM',killed:true}),value=captureNativeOriginalError(data('Native command unavailable',{cause}));assert.equal(value.cause?.message,'Native inspection read timed out');assert.equal(value.cause?.code,'ETIMEDOUT');assert.equal(value.cause?.signal,'SIGTERM');assert.equal(value.cause?.killed,true);assert(Object.isFrozen(value)&&Object.isFrozen(value.cause));
});
test('private text scrubs credentials, JSON assignments, URI credentials/query, hex/base64 and controls',()=>{
 const secrets=['fixtureBearerAbc','quoted password','quotedJsonSecret','eq_token_abc','userfixture:passfixture','querySecretAbc','a'.repeat(32),'Qx7_'.repeat(12)];
 const message='Bearer '+secrets[0]+' password="'+secrets[1]+'" {"secret":"'+secrets[2]+'"} token='+secrets[3]+' https://'+secrets[4]+'@127.0.0.1/path?a='+secrets[5]+'&b=anotherValue '+secrets[6]+' '+secrets[7]+'\u001b\u0000';
 const output=JSON.stringify(captureNativeOriginalError(data(message)));for(const value of secrets)assert(!output.includes(value),value);assert(output.includes('[REDACTED]'));assert(!captureNativeOriginalError(data(message)).message?.match(/[\u0000-\u001f\u007f-\u009f]/));
});
test('own getters, proxies, inherited fields and options accessors are never invoked',()=>{
 let calls=0;const error=Object.create({message:'PRIVATE inherited',code:'EIO'});for(const key of ['message','stack','code','signal','killed','stderr','cause'])Object.defineProperty(error,key,{get(){calls++;throw Error('PRIVATE getter');}});
 assert.deepEqual(captureNativeOriginalError(error,{captureStderr:true}),{exceptionClass:'Other'});assert.equal(calls,0);
 const proxy=new Proxy(error,{get(){calls++;throw Error();},getOwnPropertyDescriptor(){calls++;throw Error();},getPrototypeOf(){calls++;throw Error();}});assert.deepEqual(captureNativeOriginalError(proxy),{exceptionClass:'Other'});assert.equal(calls,0);
 const options=Object.defineProperty({},'captureStderr',{get(){calls++;throw Error();}});assert.equal(captureNativeOriginalError(data('Native command unavailable',{stderr:'PRIVATE'}),options).stderr,undefined);assert.equal(calls,0);
});
test('stderr is opt-in, bounded, scrubbed through causes and no unrelated process fields are retained',()=>{
 const inner=data('inspection',{stderr:'password=fixture_password',stdout:'PRIVATE stdout',argv:['PRIVATE'],env:{secret:'PRIVATE'}}),outer=data('Native command unavailable',{cause:inner,stderr:'token=fixture_token'});
 const absent=captureNativeOriginalError(outer);assert.equal(absent.stderr,undefined);assert.equal(absent.cause?.stderr,undefined);
 const enabled=captureNativeOriginalError(outer,{captureStderr:true});assert(enabled.stderr?.includes('[REDACTED]'));assert(enabled.cause?.stderr?.includes('[REDACTED]'));assert(!JSON.stringify(enabled).includes('PRIVATE'));assert.equal(captureNativeOriginalError(data('inspection',{stderr:'x'.repeat(8193)}),{captureStderr:true}).stderr,undefined);
});
test('UTF8 limits, cause depth2, cycles and unknown code/signal stay bounded',()=>{
 const value=captureNativeOriginalError(data('é'.repeat(3000),{stack:'é'.repeat(10000),cause:data('level1',{cause:data('level2',{cause:data('PRIVATE level3')})})}));assert(Buffer.byteLength(value.message??'')<=2048);assert(Buffer.byteLength(value.stack??'')<=8192);assert.equal(value.cause?.cause?.message,'level2');assert.equal(value.cause?.cause?.cause,undefined);
 const cyclic:any=data('Native command unavailable');cyclic.cause=cyclic;assert.equal(captureNativeOriginalError(cyclic).cause?.cause,undefined);
 for(const code of ['PRIVATE',-1,256,1.5,true])assert.equal(captureNativeOriginalError(data('fixed',{code,signal:'PRIVATE',killed:'yes'})).code,undefined);
 for(const signal of ['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGPIPE','SIGINT','SIGHUP','SIGBUS','SIGILL','SIGFPE','SIGQUIT'])assert.equal(captureNativeOriginalError(data('fixed',{signal})).signal,signal);
});
