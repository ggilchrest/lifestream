import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
let input='';for await(const chunk of process.stdin)input+=chunk;const cfg=JSON.parse(input),config=loadProfile('test');config.providers.tts='voxcpm';config.ttsProfile=cfg.profile;config.storage={databasePath:cfg.databasePath,artifactDirectory:cfg.artifactDirectory};config.authority.authentication='local-password';
const app=createLifestreamServer({config,localAuth:{stateDirectory:cfg.authDirectory,installerToken:cfg.installerToken},audiencePrivacy:{}});await app.start();process.stdout.write(JSON.stringify({port:app.address().port})+'\n');process.on('SIGTERM',()=>{void app.shutdown().then(()=>process.exit(0));});
