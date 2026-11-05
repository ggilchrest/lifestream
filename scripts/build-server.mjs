import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {dirname,join} from 'node:path';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {verifyNativeTemplate} from './check-native-template.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
verifyNativeTemplate(join(root,'integration/ct-launcher/ct-native-template52.json'),join(root,'packages/providers-bizhawk/native'));
const result = spawnSync(process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'apps/server'],
  { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
await require('esbuild').build({
  absWorkingDir: root, entryPoints: ['apps/control-web/vad-source.js'],
  bundle: true, format: 'esm', outfile: 'apps/control-web/vad-bundle.js',
});

// These runtime MJS companions are outside tsc's output. Keep their exact
// relative import closure explicit, including the supervised controller guard.
const companions=[
 ['bounded-audit.mjs',[]],
 ['ubuntu-game-composition.mjs',[
  ['./game-phase-timing.ts','./game-phase-timing.js'],
  ['./game-scene-eligibility.ts','./game-scene-eligibility.js'],
  ['./game-observation-deadline.ts','./game-observation-deadline.js'],
  ['../../../../packages/providers-bizhawk/src/native-execution-lifetime.ts','../../../../packages/providers-bizhawk/dist/native-execution-lifetime.js'],
  ['../../../../packages/providers-bizhawk/src/game-sanity-timing.ts','../../../../packages/providers-bizhawk/dist/game-sanity-timing.js'],
  ['../../../../packages/providers-bizhawk/src/reviewed-live-frame.ts','../../../../packages/providers-bizhawk/dist/reviewed-live-frame.js'],
  ['./game-visual-goal.ts','./game-visual-goal.js'],
  ['./ct-visible-goal-policy.ts','./ct-visible-goal-policy.js'],
  ['./ct-action-evidence.ts','./ct-action-evidence.js'],
  ['./ct-wake-handoff.ts','./ct-wake-handoff.js'],
  ['./ct-observation-evidence.ts','./ct-observation-evidence.js'],
  ['./reviewed-game-scene.ts','./reviewed-game-scene.js'],
  ['./reviewed-dialogue-profile.ts','./reviewed-dialogue-profile.js'],
  ['../../../../packages/providers-bizhawk/src/owned-c72-native.ts','../../../../packages/providers-bizhawk/dist/owned-c72-native.js'],
  ['../../../../packages/providers-bizhawk/src/c72-native-configuration.ts','../../../../packages/providers-bizhawk/dist/c72-native-configuration.js'],
  ['./game-campaign-owner.ts','./game-campaign-owner.js'],
  ['./game-frame-interpretation.ts','./game-frame-interpretation.js'],
  ['./game-host-runtime.ts','./game-host-runtime.js'],
  ['./ct-controller-buttons.ts','./ct-controller-buttons.js'],
 ]],
 ['ubuntu-presence-native-frame5.mjs',[
  ['./ubuntu-presence-host-factory.ts','./ubuntu-presence-host-factory.js'],
 ]],
 ['ubuntu-game-join.mjs',[
  ['../../../../packages/providers-bizhawk/src/game-host-client.ts','../../../../packages/providers-bizhawk/dist/game-host-client.js'],
 ]],
];
for(const [name,rewrites]of companions){
 const destination=join(root,'apps/server/dist/runtime',name);
 let text=await readFile(join(root,'apps/server/src/runtime',name),'utf8');
 for(const [before,after]of rewrites){
  assert(text.includes("'"+before+"'"),'Missing reviewed companion import: '+before);
  await access(join(dirname(destination),after));
  text=text.replaceAll("'"+before+"'","'"+after+"'");
 }
 assert(!/(?:from\s*|import\s*\()\s*['"]\.[^'"]+\.ts['"]/.test(text),'Unmapped TypeScript companion import');
 await mkdir(dirname(destination),{recursive:true});await writeFile(destination,text);
}
