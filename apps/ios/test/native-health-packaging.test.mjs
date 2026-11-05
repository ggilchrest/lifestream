import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const ios=fileURLToPath(new URL('../',import.meta.url));
function plist(relative){const result=spawnSync('/usr/bin/plutil',['-convert','json','-o','-',ios+relative],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout)}
test('Health read purpose, minimal entitlement and existing App target wiring',{skip:process.platform!=='darwin'},()=>{
 const info=plist('ios/App/App/Info.plist'),entitlements=plist('ios/App/App/App.entitlements'),project=plist('ios/App/App.xcodeproj/project.pbxproj');
 assert.equal(info.NSHealthShareUsageDescription,'Read the sleep and related Health measurements you choose for your configured Lifestream connection. Your existing source and use settings remain in control.');
 assert.equal(Object.hasOwn(info,'NSHealthUpdateUsageDescription'),false);
 assert.deepEqual(entitlements,{'com.apple.developer.healthkit':true});
 const objects=project.objects,app=Object.entries(objects).filter(([,v])=>v.isa==='PBXNativeTarget'&&v.name==='App');assert.equal(app.length,1);
 const [id,target]=app[0],configs=objects[target.buildConfigurationList].buildConfigurations.map(key=>objects[key]);
 assert.deepEqual(configs.map(v=>v.name).sort(),['Debug','Release']);
 for(const config of configs){assert.equal(config.buildSettings.CODE_SIGN_ENTITLEMENTS,'App/App.entitlements');assert.equal(config.buildSettings.INFOPLIST_FILE,'App/Info.plist');assert.equal(config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER,'org.lifestream.assistant');assert.equal(config.buildSettings.CODE_SIGN_STYLE,'Automatic')}
 assert.deepEqual(objects[project.rootObject].attributes.TargetAttributes[id].SystemCapabilities,{'com.apple.HealthKit':{enabled:'1'}});
 const collector=readFileSync(ios+'ios/App/CapApp-SPM/Sources/CapApp-SPM/HealthKitCollector.swift','utf8');
 assert.match(collector,/requestAuthorization\(toShare:\[\],read:Set\(mapped\)\)/);
 assert.doesNotMatch(collector,/health\.(?:save|delete)\(/);
});
