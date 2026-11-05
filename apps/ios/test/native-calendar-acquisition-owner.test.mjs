import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('actual native Calendar acquisition owner with offline external ports',{timeout:180000},t=>{
 if(process.platform!=='darwin'){t.skip('macOS and Xcode required');return;}
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'calendar-acquisition-owner-'));
 t.diagnostic('Evidence build directory: '+temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 assert.equal(build.status,0,build.stderr+build.stdout.slice(-8000));
 copyFileSync(new URL('./native-calendar-acquisition-owner-probe.swift',import.meta.url),join(temp,'main.swift'));
 const products=join(temp,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 const files=['ConnectionStore','NativeTransport','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner'].map(x=>join(native,x+'.swift'));
 const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...files,join(temp,'main.swift'),'-o',join(temp,'probe')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 assert.equal(compile.status,0,compile.stderr);
 const modes=process.env.CALENDAR_ACQUISITION_MODES?.split(',')??['release-reentry','drain-observer-reentry','raw-authority-fraction','raw-generation-fraction','raw-session-fraction','raw-endpoint-fraction','raw-near-safe-fraction','raw-integer-decimal','raw-integer-exponent','config-reentry-before','config-cancel-before','happy','task','future-window','no-provider','wrong-box','denied','write-only','invalid-clock','auth-401','auth-503','human-before','session-before','config-after','window-after','protected-after','lease-after','epoch-after','origin-after','reference-after','revision-after','generation-after','endpoint-revision-after','endpoint-after','privacy-after','ended-after','revision-policy','categories-policy','source-policy','binding-policy','final-reentrant','cancel-policy','never-policy','cancel-auth','cancel-sdk','late-token','entered-callback','duplicate-callback','held-worker','write-after','write-before'];
 const failures=[];
 for(const mode of modes){
  const stages=mode.startsWith('delivery-final-')||mode.endsWith('-drift')||mode.startsWith('delivery-policy-')||mode==='delivery-refresh-queue-change'||mode==='delivery-cancel-reauthorize'?['send','settle']:['send'];
  for(const stage of stages){
  const run=spawnSync(join(temp,'probe'),[mode],{encoding:'utf8',timeout:10000,env:{...process.env,CALENDAR_DELIVERY_STAGE:stage,CALENDAR_FIXTURE:join(ios,'test/mobile-calendar-fixtures/delivery-receipts.json'),LLVM_PROFILE_FILE:join(temp,mode+'-'+stage+'-%p.profraw')}});
  if(run.status!==0||!new RegExp(mode+' passed').test(run.stdout)){failures.push(mode+'/'+stage+': '+run.stderr+run.stdout);t.diagnostic(mode+'/'+stage+' FAILED');}else t.diagnostic(mode+'/'+stage+' passed');
  }
 }
 assert.deepEqual(failures,[]);
});
