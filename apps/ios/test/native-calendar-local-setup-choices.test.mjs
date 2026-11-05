import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
test('first local Calendar setup uses original admission and shared owner',{timeout:180000},t=>{
 assert.equal(process.platform,'darwin','macOS/Xcode qualification required; no skipped success');
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'calendar-local-setup-'));t.diagnostic('Evidence directory: '+temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});assert.equal(build.status,0,build.stderr+build.stdout.slice(-7000));
 // Compose with the existing sealed TEST-ONLY offline transport/store fixture.
 const original=readFileSync(new URL('./native-calendar-saved-choices-probe.swift',import.meta.url),'utf8');
 let fixture=original.slice(0,original.indexOf('@MainActor func run()'));
 assert.ok(fixture.length>5000,'explicit existing fixture boundary');
 fixture=fixture.replace('failAfter=false,failOnEmptyQueue=false','failBefore=false,failAfter=false,failOnEmptyQueue=false').replace('writes+=1;data=d;','writes+=1;if failBefore{throw CocoaError(.fileWriteUnknown)};data=d;localAfterWrite?();');
 fixture=fixture.replace('allocations+=1','allocations+=1;localReentry?()');
 fixture=fixture.replace('send(fixture["policy"]!);return','if mode=="setup" && site=="denied"{var p=fixture["policy"] as! [String:Any],r=p["result"] as! [String:Any],e=r["effective"] as! [String:Any];e["collectionAllowed"]=false;r["effective"]=e;p["result"]=r;send(p);return};send(fixture["policy"]!);return');
 const combined=fixture+'\n'+readFileSync(new URL('./native-calendar-local-setup-choices-probe.swift',import.meta.url),'utf8');
 writeFileSync(join(temp,'main.swift'),combined);
 writeFileSync(join(temp,'fixture-composition.json'),JSON.stringify({originalFixtureSHA256:createHash('sha256').update(original).digest('hex'),combinedSHA256:createHash('sha256').update(combined).digest('hex')},null,2));
 const products=join(temp,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 const files=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner'].map(x=>join(native,x+'.swift'));
 const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...files,join(temp,'main.swift'),'-o',join(temp,'probe')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});assert.equal(compile.status,0,compile.stderr);
 const modes=process.env.CALENDAR_LOCAL_SETUP_MODE==='selector-bytes'?{binding:['selector-bytes']}:{defaults:['no-local-port','missing-kind-currency','bad-pair'],catalog:['inert','opaque','stale','wrong-kind'],request:['extra','forged'],setup:['saved','denied','context','duplicate','cross-health'],unknown:['before','after'],transition:['same-root','separate-action'],binding:['selector-bytes']};
 let count=0;const failures=[];
 for(const [mode,sites]of Object.entries(modes))for(const site of sites){count++;const run=spawnSync(join(temp,'probe'),[mode,site],{encoding:'utf8',timeout:20000,env:{...process.env,CALENDAR_FIXTURE:join(ios,'test/mobile-calendar-fixtures/delivery-receipts.json'),LLVM_PROFILE_FILE:join(temp,mode+'-'+site+'-%p.profraw')}});if(run.status!==0||!run.stdout.includes(mode+'/'+site+' passed'))failures.push(mode+'/'+site+': '+run.stderr+run.stdout);else t.diagnostic(mode+'/'+site+' passed')}
 assert.equal(count,process.env.CALENDAR_LOCAL_SETUP_MODE==='selector-bytes'?1:19);assert.deepEqual(failures,[]);
});
