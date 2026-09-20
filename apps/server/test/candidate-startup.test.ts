import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('candidate CLI keeps authenticated administration available across startup outage and provider recovery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'candidate-startup-')),directory=join(root,'candidate'),available=join(root,'available'),hook=join(root,'outage.mjs');
 const registry=new URL('../src/composition/providers.ts',import.meta.url).href,experience=new URL('../src/runtime/experience.ts',import.meta.url).href,started=join(root,'background-started');
 await writeFile(hook,`import {existsSync,writeFileSync} from 'node:fs';import {ExperientialLearning} from ${JSON.stringify(experience)};const start=ExperientialLearning.prototype.start;ExperientialLearning.prototype.start=function(){writeFileSync(${JSON.stringify(started)},'started');return start.call(this);};import {ProviderRegistry} from ${JSON.stringify(registry)};ProviderRegistry.prototype.probe=async function(){this.providers.inference={...this.providers.inference,required:true,status:existsSync(${JSON.stringify(available)})?'healthy':'unavailable',reason:'synthetic outage'};};`);
 const reserved=createServer();await new Promise<void>(resolve=>reserved.listen(0,'127.0.0.1',resolve));const port=(reserved.address() as {port:number}).port;await new Promise<void>(resolve=>reserved.close(()=>resolve()));
 const child=spawn(process.execPath,['--import',pathToFileURL(hook).href,'scripts/start-candidate.mjs','--directory',directory,'--profile','test','--port',String(port)],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});
 const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;await rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<150;i++){if(child.exitCode!==null)assert.fail('Candidate exited during a synthetic provider outage: '+output);if(output.includes('"health"'))break;await new Promise(resolve=>setTimeout(resolve,50));}
 assert.match(output,/"health"/,'Candidate should finish startup while its selected provider is unavailable');assert.equal(existsSync(started),false);
 const down=await fetch(base+'/health');assert.equal(down.status,503);assert.equal((await down.json() as any).acceptingInteractions,false);assert.equal((await fetch(base+'/health/live')).status,200);assert.equal((await fetch(base+'/control/')).status,200);
 assert.equal((await fetch(base+'/api/auth/v1/session')).status,401);
 const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'synthetic-owner',password:randomBytes(32).toString('hex'),installerToken:(await readFile(join(directory,'installer-token.txt'),'utf8')).trim()})});assert.equal(setup.status,201);
 const cookie=setup.headers.get('set-cookie')!.split(';')[0]!;assert.equal((await fetch(base+'/api/admin/v1/assistants',{headers:{cookie}})).status,200);
 await writeFile(available,'synthetic recovery');const up=await fetch(base+'/health/ready');assert.equal(up.status,200);assert.equal((await up.json() as any).acceptingInteractions,true);assert.equal(existsSync(started),true,'Background learning must start after readiness recovers');
 await rm(available);assert.equal((await fetch(base+'/health/ready')).status,503);assert.equal((await fetch(base+'/control/')).status,200);
 child.kill('SIGTERM');const [code]=await exited;assert.equal(code,0);
});
