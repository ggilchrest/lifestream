import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('manual Calendar collection reuses original acquisition and delivery owners',{timeout:180000},t=>{
 assert.equal(process.platform,'darwin','macOS/Xcode qualification required; no skipped success');
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'calendar-manual-sync-'));t.diagnostic('Evidence directory: '+temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});assert.equal(build.status,0,build.stderr+build.stdout.slice(-7000));
 const original=readFileSync(new URL('./native-calendar-saved-choices-probe.swift',import.meta.url),'utf8'),runtimeFixture=readFileSync(new URL('./native-health-runtime-probe.swift',import.meta.url),'utf8');
 let fixture=original.slice(0,original.indexOf('@MainActor func run()')).replace('import AssistantCore','@testable import AssistantCore');
 fixture=fixture.replace('data=d;if failAfter','data=d;if mode=="holds" && site=="acquisition" && queueCount(d)>0{failAfter=true};if failAfter');
 fixture=fixture.replace('mode=="pending" && site=="transport"','mode=="delivery" && site=="transport"').replace('mode=="pending" && site=="receipt"','mode=="delivery" && site=="receipt"');
 fixture=fixture.replace('let items=(payload["items"]','if mode=="holds" && site=="settlement"{disk.failOnEmptyQueue=true};let items=(payload["items"]');
 let sdk=runtimeFixture.slice(runtimeFixture.indexOf('struct SharedEvent:'),runtimeFixture.indexOf('func sharedSelection('));
 assert.ok(sdk.includes('final class SharedStore'),'exact sealed existing SDK fixture reused');
 sdk=sdk.replace('sharedAccessChecks+=1;return .fullRead','sharedAccessChecks+=1;return mode=="fences" && site=="SDK-denied" ? .denied:.fullRead');
 sdk=sdk.replace('sharedQueries+=1;_ = yield(SharedEvent())','sharedQueries+=1;if mode=="fences" && site=="cancel"{connection!.host.calendarCancel()};if !(mode=="collect" && site=="empty"){_ = yield(SharedEvent())}');
 const combined=fixture+'\n'+sdk+'\n'+readFileSync(new URL('./native-calendar-manual-sync-probe.swift',import.meta.url),'utf8');writeFileSync(join(temp,'main.swift'),combined);writeFileSync(join(temp,'original-saved-fixture.swift'),original);writeFileSync(join(temp,'original-sdk-fixture.swift'),runtimeFixture);

 const products=join(temp,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 const files=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner'].map(x=>join(native,x+'.swift'));
 const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...files,join(temp,'main.swift'),'-o',join(temp,'probe')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});assert.equal(compile.status,0,compile.stderr);
 const modes={defaults:['absent','wrong-owner'],review:['inert','closed','stale'],collect:['event','task','empty'],delivery:['transport','receipt'],holds:['acquisition','settlement'],fences:['duplicate','context','SDK-denied','cancel']};
 let count=0;const failures=[];
 for(const [mode,sites]of Object.entries(modes))for(const site of sites){count++;const run=spawnSync(join(temp,'probe'),[mode,site],{encoding:'utf8',timeout:20000,env:{...process.env,CALENDAR_FIXTURE:join(ios,'test/mobile-calendar-fixtures/delivery-receipts.json'),LLVM_PROFILE_FILE:join(temp,mode+'-'+site+'-%p.profraw')}});writeFileSync(join(temp,mode+'-'+site+'.log'),run.stdout+run.stderr);if(run.status!==0||!run.stdout.includes(mode+'/'+site+' passed'))failures.push(mode+'/'+site+': '+run.stderr+run.stdout);else t.diagnostic(mode+'/'+site+' passed')}
 assert.equal(count,16);assert.deepEqual(failures,[]);
});
