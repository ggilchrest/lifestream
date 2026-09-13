// Explicit opt-in development instance: no selected-provider service or live profile is changed.
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createLifestreamServer } from '../apps/server/src/index.ts';
import { loadProfile, isProfile } from '../apps/server/src/config/loader.ts';
const root=process.env.LIFESTREAM_ISOLATED_DIRECTORY;
if(!root || !process.env.LIFESTREAM_INSTALLER_TOKEN_FILE)throw new Error('Set LIFESTREAM_ISOLATED_DIRECTORY and LIFESTREAM_INSTALLER_TOKEN_FILE to explicit private local paths.');
const profile=process.env.LIFESTREAM_PROFILE||'test';if(!isProfile(profile))throw new Error('Unknown explicitly selected profile.');
const directory=resolve(root),config=loadProfile(profile);
config.storage={databasePath:join(directory,'application.sqlite'),artifactDirectory:join(directory,'artifacts')};
config.authority={...config.authority,authentication:'local-password'};
const app=createLifestreamServer({config,port:Number(process.env.PORT||0),localAuth:{stateDirectory:join(directory,'authentication-safety'),installerToken:readFileSync(process.env.LIFESTREAM_INSTALLER_TOKEN_FILE,'utf8').trim()}});
await app.start();
console.log(`Isolated ${profile} instance: http://127.0.0.1:${app.address().port}/control/`);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.shutdown().then(()=>process.exit(0));});
