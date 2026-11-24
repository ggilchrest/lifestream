import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('saved Calendar normal controls use original offline Host and owner',{timeout:180000},t=>{
 assert.equal(process.platform,'darwin','macOS/Xcode qualification required; no skipped success');
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'calendar-saved-choices-'));t.diagnostic('Evidence directory: '+temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});assert.equal(build.status,0,build.stderr+build.stdout.slice(-7000));
 copyFileSync(new URL('./native-calendar-saved-choices-probe.swift',import.meta.url),join(temp,'main.swift'));
 const products=join(temp,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 const files=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner'].map(x=>join(native,x+'.swift'));
 const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...files,join(temp,'main.swift'),'-o',join(temp,'probe')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});assert.equal(compile.status,0,compile.stderr);
 const modes={defaults:['missing-profile','missing-currency','invalid-descriptor'],binding:['once','refused-second','revoked'],catalog:['inert','opaque-only','refresh'],request:['extra','forged-catalog','forged-choice','stale'],reconnect:['positive','failed','late-context'],pending:['before-reconnect','empty','settled','transport','receipt','unconfirmed'],fences:['duplicate','context','profile-revoke','unknown-hold']};
 let count=0;const failures=[];
 for(const [mode,sites]of Object.entries(modes))for(const site of sites){count++;const run=spawnSync(join(temp,'probe'),[mode,site],{encoding:'utf8',timeout:20000,env:{...process.env,CALENDAR_FIXTURE:join(ios,'test/mobile-calendar-fixtures/delivery-receipts.json'),LLVM_PROFILE_FILE:join(temp,mode+'-'+site+'-%p.profraw')}});if(run.status!==0||!run.stdout.includes(mode+'/'+site+' passed'))failures.push(mode+'/'+site+': '+run.stderr+run.stdout);else t.diagnostic(mode+'/'+site+' passed')}
 assert.equal(count,26);assert.deepEqual(failures,[]);
});
