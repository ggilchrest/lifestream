import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('Calendar read permission uses original current saved owner and real callback drain',{timeout:180000},t=>{
 assert.equal(process.platform,'darwin','macOS/Xcode qualification required; no skipped success');
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'calendar-permission-'));t.diagnostic('Evidence directory: '+temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});assert.equal(build.status,0,build.stderr+build.stdout.slice(-7000));
 const original=readFileSync(new URL('./native-calendar-saved-choices-probe.swift',import.meta.url),'utf8');
 let fixture=original.slice(0,original.indexOf('@MainActor func run()'));
 fixture=fixture.replace('reads+=1;return data','reads+=1;permissionReadHook?();return data');
 fixture=fixture.replace('final class Custody:NativeSharedOutboxCustodyLease{','final class Custody:NativeCalendarReadPermissionCustody{\n func readPermissionCurrency(binding:NativeCalendarReadPermissionCurrency.Binding)->NativeCalendarReadPermissionCurrency?{if scenario=="missing-parent"{return nil};let c=NativeCalendarReadPermissionCurrency(owner:scenario=="wrong-parent" ? NSObject():self,binding:binding);parentPermissionCurrency=c;return c}');
 fixture=fixture.replace('return try body()','let value=try body();permissionFenceHook?();return value');
 fixture=fixture.replace('released=true}','released=true;permissionReleases+=1;permissionReleaseHook?()}');
 fixture=fixture.replace('send(fixture["policy"]!);return','send(permissionPolicy());return');
 const combined=fixture+'\n'+readFileSync(new URL('./native-calendar-read-permission-probe.swift',import.meta.url),'utf8');
 writeFileSync(join(temp,'main.swift'),combined);writeFileSync(join(temp,'original-fixture.swift'),original);
 const products=join(temp,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 const files=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner'].map(x=>join(native,x+'.swift'));
 const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...files,join(temp,'main.swift'),'-o',join(temp,'probe')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});assert.equal(compile.status,0,compile.stderr);
 const targeted=process.env.CALENDAR_PERMISSION_CASE==='release-unwind';
 const modes=targeted?{callback:['sync'],fences:['custody']}:{defaults:['absent','wrong-currency','unbound'],authority:['no-reconnect','denied','changed','paused'],status:['full-events','full-reminders','denied','restricted','write-only','unknown'],callback:['sync','async','false','error','duplicate','off-main'],fences:['reentry','late','never','custody','forged']};
 let groups=0,processes=0;const failures=[];
 for(const [mode,sites]of Object.entries(modes))for(const site of sites){groups++;
  const subs=targeted&&mode==='fences'?['release-unwind']:mode==='fences'&&site==='custody'?['raw-read','fence-unwind','currency-unwind','config-unwind','pause','retire','missing-parent','wrong-parent','sdk-final','release-unwind']:['default'];
  for(const sub of subs){processes++;const run=spawnSync(join(temp,'probe'),[mode,site],{encoding:'utf8',timeout:20000,env:{...process.env,PERMISSION_SUBCASE:sub,CALENDAR_FIXTURE:join(ios,'test/mobile-calendar-fixtures/delivery-receipts.json'),LLVM_PROFILE_FILE:join(temp,mode+'-'+site+'-'+sub+'-%p.profraw')}});writeFileSync(join(temp,mode+'-'+site+'-'+sub+'.log'),run.stdout+run.stderr);if(run.status!==0||!run.stdout.includes(mode+'/'+site+' passed'))failures.push(mode+'/'+site+'/'+sub+': '+run.stderr+run.stdout);else t.diagnostic(mode+'/'+site+'/'+sub+' passed')}
 }
 assert.equal(groups,targeted?2:24);assert.equal(processes,targeted?2:33);assert.deepEqual(failures,[]);
});
