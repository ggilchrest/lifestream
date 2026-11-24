import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('original Health connection owner composes the existing offline runtime',{timeout:180000},t=>{
 if(process.platform!=='darwin'){t.skip('macOS Foundation and Xcode required');return;}
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'health-connection-owner-'));
 t.diagnostic('Evidence build directory: '+temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 assert.equal(build.status,0,build.stderr+build.stdout.slice(-8000));
 copyFileSync(new URL('./native-health-connection-owner-probe.swift',import.meta.url),join(temp,'main.swift'));
 const products=join(temp,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM');
 const files=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner'].map(x=>join(native,x+'.swift'));
 const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...files,join(temp,'main.swift'),'-o',join(temp,'probe')],{encoding:'utf8',timeout:60000});
 assert.equal(compile.status,0,compile.stderr);
 const modes=['connection-missing-profile','connection-invalid-profile','connection-inert','connection-bind-once','connection-catalog','connection-context','connection-source','connection-separate-actions','connection-revoke','connection-factory-reentry','connection-unknown-hold','connection-lifecycle'];
 const sites={'connection-context':['human','session','origin','endpoint'],'connection-source':['namespace','enrollment','inactive'],'connection-factory-reentry':['storage','SDK'],'connection-unknown-hold':['write-before-throw','write-after-throw'],'connection-lifecycle':['temporary','authority']};
 for(const mode of modes)for(const site of sites[mode]??['default']){
  const result=spawnSync(join(temp,'probe'),[mode,site],{encoding:'utf8',timeout:20000,env:{...process.env,LLVM_PROFILE_FILE:join(temp,`${mode}-${site}-%p.profraw`)}});
  assert.equal(result.status,0,`${mode}/${site}: ${result.stderr} ${result.stdout}`);
  assert.ok(result.stdout.includes(`${mode}/${site} passed`));t.diagnostic(`${mode}/${site} passed`);
 }
});
