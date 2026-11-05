import {mkdirSync,lstatSync,writeFileSync,renameSync,readFileSync,unlinkSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';import {join} from 'node:path';
import {createAudit,auditRoot} from '../apps/server/src/runtime/bounded-audit.mjs';
const [command,mode='metadata',duration='300']=process.argv.slice(2),path=join(auditRoot,'control.json');
function directory(){mkdirSync(auditRoot,{mode:0o700});}
function verify(){const s=lstatSync(auditRoot);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('unsafe_directory');}
try{
 if(command==='arm'){
  if(!existsSync(auditRoot))directory();verify();if(existsSync(path))throw Error('switch_already_present_use_off_first');const seconds=Number(duration);if(!['metadata','content'].includes(mode)||!Number.isSafeInteger(seconds)||seconds<1||seconds>300)throw Error('invalid_capture_bounds');
  const startedAtMs=Date.now(),id=randomUUID(),c={version:1,id,startedAtMs,expiresAtMs:startedAtMs+seconds*1000,mode};const temp=join(auditRoot,'.control-'+randomUUID());writeFileSync(temp,JSON.stringify(c)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path);console.log(JSON.stringify({state:'armed_switch_requested',session:id,startsAt:new Date(startedAtMs).toISOString(),endsAt:new Date(c.expiresAtMs).toISOString(),contentEnabled:mode==='content'}));
 }else if(command==='off'){
  verify();try{unlinkSync(path);}catch(e){if(e.code!=='ENOENT')throw e;}console.log(JSON.stringify({state:'off_switch_requested',note:'Backend observes switch at next callback or within 250 ms; delivery to app depends on network.'}));
 }else if(command==='cleanup'){
  verify();const a=createAudit({timers:false});const cleaned=a.cleanup();a.close();if(!cleaned)throw Error("cleanup_failed");console.log(JSON.stringify({state:'retention_cleanup_completed'}));
 }else if(command==='status'){
  verify();let c;try{const s=lstatSync(path);if(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077)&&s.size<=2048)c=JSON.parse(readFileSync(path,'utf8'));}catch{}console.log(JSON.stringify({state:c?.version===1&&c.expiresAtMs>Date.now()?'switch_armed':'off',note:'Switch state is advisory; authenticated audience diagnostics is the backend active-session acknowledgement.'}));
 }else throw Error('usage_arm_metadata_or_content_seconds_off_status_cleanup');
}catch{console.error('Audit control refused: invalid command, bounds, existing switch or private storage permissions.');process.exitCode=1;}
