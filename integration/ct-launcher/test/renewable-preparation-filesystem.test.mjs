// Executes the selected production filesystem ports against toy private files.
// No registration, runtime job directory, backend, authentication or native actor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {constants,readFileSync} from 'node:fs';
import {mkdtemp,chmod,lstat,open,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {compileFunction} from 'node:vm';
const sha=raw=>createHash('sha256').update(raw).digest('hex'),json=JSON.stringify,digest=value=>sha(json(value));
const fail=code=>{throw Object.assign(Error(code),{code});};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ct67-file-gate-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 const identity=await lstat(root),selection={jobId:randomUUID(),nonce:'TOY-nonoperational'};
 const source=readFileSync(new URL('../dedicated-ct-job.mjs',import.meta.url),'utf8'),a=source.indexOf('const same='),b=source.indexOf('export async function registerDedicatedCtJob(',a),p=source.indexOf(' const ports={',b),q=source.indexOf('\n return createDedicatedCtJobCore(',p);assert(a>=0&&b>a&&p>b&&q>p);
 const currentRoot=async()=>{const now=await lstat(root);assert.equal(now.dev,identity.dev);assert.equal(now.ino,identity.ino);};
 let sleeps=0,onSleep=()=>{},onClaim=()=>{};
 const sleep=async(ms,signal)=>{assert.equal(ms,100);assert(!signal.aborted);sleeps++;await onSleep(signal);};
 const selectedOpen=async(path,...args)=>{const handle=await open(path,...args);if(path.includes('/CONSUMED-'))await onClaim();return handle;};
 const ports=compileFunction(source.slice(a,b).replace(/^export /gm,'')+source.slice(p,q)+'\nreturn ports;',['assert','constants','lstat','open','realpath','join','dirname','sha','json','digest','fail','root','selection','currentRoot','sleep','setup'])(assert,constants,lstat,selectedOpen,realpath,join,dirname,sha,json,digest,fail,root,selection,currentRoot,sleep,true);
 const file=async(stage,value={stage})=>{const path=join(root,'dispatch-'+stage+'.json');await writeFile(path,JSON.stringify(value),{mode:0o400});return value;};
 const absent=async stage=>assert.rejects(lstat(join(root,'CONSUMED-'+stage+'.json')),{code:'ENOENT'});
 return {root,ports,file,absent,onSleep:fn=>onSleep=fn,onClaim:fn=>onClaim=fn,sleeps:()=>sleeps};
}
test('selected filesystem wait refuses two files and mismatched filename before consumption',async t=>{
 for(const conflict of [true,false]){const f=await fixture(t);await f.file('start-1',conflict?undefined:{stage:'renew-1'});if(conflict)await f.file('renew-1');await assert.rejects(f.ports.waitDispatch(['start-1','renew-1'],new AbortController().signal,null),{code:conflict?'ct_job_conflicting_dispatches':'ct_job_dispatch_mismatch'});await f.absent('start-1');await f.absent('renew-1');assert.equal(f.sleeps(),0);}
});
test('selected filesystem polling uses one waiter and cancellation leaves no loser or claim',async t=>{
 const f=await fixture(t),cancel=new AbortController();f.onSleep(()=>cancel.abort());await assert.rejects(f.ports.waitDispatch(['start-7','renew-7'],cancel.signal,null),{code:'ct_job_dispatch_deadline'});assert.equal(f.sleeps(),1);await f.absent('start-7');await f.absent('renew-7');
});
test('selected filesystem choice consumes only the exact reviewed bytes once',async t=>{
 for(const stage of ['start-1','renew-1']){const f=await fixture(t),value={stage,reviewed:'toy'},alternatives=['start-1','renew-1'];f.onSleep(()=>f.file(stage,value));const chosen=await f.ports.waitDispatch(alternatives,new AbortController().signal,null);assert.deepEqual(chosen,value);assert.equal(f.sleeps(),1);await f.ports.consumeDispatch(stage,digest(chosen),alternatives);const claim=JSON.parse(await readFile(join(f.root,'CONSUMED-'+stage+'.json'),'utf8'));assert.equal(claim.dispatchDigest,digest(chosen));assert.equal((await lstat(join(f.root,'CONSUMED-'+stage+'.json'))).mode&0o777,0o400);await assert.rejects(f.ports.consumeDispatch(stage,digest(chosen),alternatives),{code:'EEXIST'});await f.absent(stage==='start-1'?'renew-1':'start-1');}
});
test('selected filesystem rechecks competing file and changed bytes immediately before claim',async t=>{
 for(const change of ['competitor','bytes']){const f=await fixture(t),value=await f.file('start-1'),chosen=await f.ports.waitDispatch(['start-1','renew-1'],new AbortController().signal,null);assert.deepEqual(chosen,value);if(change==='competitor')await f.file('renew-1');else{await chmod(join(f.root,'dispatch-start-1.json'),0o600);await f.file('start-1',{stage:'start-1',changed:true});}await assert.rejects(f.ports.consumeDispatch('start-1',digest(chosen),['start-1','renew-1']),{code:change==='competitor'?'ct_job_conflicting_dispatches':'ct_job_dispatch_changed'});await f.absent('start-1');}
});
test('competitor appearing during durable consumption is refused before an instruction returns',async t=>{
 const f=await fixture(t),value=await f.file('start-1');f.onClaim(()=>f.file('renew-1'));await assert.rejects(f.ports.consumeDispatch('start-1',digest(value),['start-1','renew-1']),{code:'ct_job_conflicting_dispatches'});assert((await lstat(join(f.root,'CONSUMED-start-1.json'))).isFile(),'The uncertain consumed claim is preserved, never reset');
});
