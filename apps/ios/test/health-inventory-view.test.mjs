import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

test('selected Health view scopes status, protective pause and known-pause resume',{timeout:30000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 const dir=await mkdtemp(join(tmpdir(),'health-inventory-ui-')),entry=join(dir,'entry.js');
 await writeFile(entry,`import {createHealthInventoryView} from ${JSON.stringify(fileURLToPath(new URL('../web/health-inventory-view.js',import.meta.url)))};
 window.calls=0;window.mutationCalls=0;window.contextRevision=1;window.statusCalls=[];window.allowed=true;window.ownerVersion=1;window.wait=false;window.statusWait=false;window.pending=[];
 window.endpoint='60000000-0000-4000-8000-000000000001';
 window.native={healthInventory:()=>{calls++;return window.wait?new Promise(resolve=>window.finish=resolve):Promise.resolve(window.payload)},healthStatus:request=>{window.statusCalls.push(request);return window.statusWait?new Promise(resolve=>window.pending.push({request,resolve})):Promise.resolve(window.reply(request))},healthSetup:()=>{mutationCalls++;throw Error('unexpected setup')},healthSync:()=>{mutationCalls++;throw Error('unexpected sync')}};
 window.reply=request=>({schemaVersion:'1.0.0',state:'ready',reason:'ready',binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId,policyRevision:request.policyRevision,contextRevision:request.contextRevision},local:{policyConfirmed:true,localChangePending:false,paused:false,requiresRebind:false,busy:false}});
 window.payload={sources:[1,2].map(i=>({collector:'healthKit',sourceNamespace:'00000000-0000-4000-8000-00000000000'+i,currentState:'active',currentEnrollmentId:'00000000-0000-4000-8000-00000000001'+i,policyRevision:1,categories:['SleepSegment'],uses:['answers'],assistantIds:['a'],collectionPaused:false,usePaused:false,preferredSource:'Synthetic source'})),unboundEnrollments:[]};
 window.ui=createHealthInventoryView({root:document.querySelector('#root'),native,owner:()=>window.allowed?{id:window.ownerVersion,endpointId:window.endpoint,revision:window.contextRevision}:null,current:identity=>window.allowed&&identity.id===window.ownerVersion&&identity.endpointId===window.endpoint&&identity.revision===window.contextRevision});`);
 await build({entryPoints:[entry],outfile:join(dir,'bundle.js'),bundle:true,platform:'browser'});
 const browser=await chromium.launch({channel:'chrome'});t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true})});
 const page=await browser.newPage();await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});
 assert.equal(await page.evaluate(()=>calls),0);assert.equal(await page.evaluate(()=>statusCalls.length),0);
 await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');
 assert.equal(await page.getByText('This phone: Connected',{exact:true}).count(),0,'remote active is not local Connected');
 await page.getByText('Server enrollment: Active',{exact:true}).waitFor();await page.getByText('Local setup: Ready',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button').count(),2);assert.equal(await page.evaluate(()=>statusCalls.length),1);
 // Unknown/malformed results must not become positive observations.
 for(const alteration of ['missing','version','binding','flags','reason','unavailable','paused-contradiction','rebind-contradiction','pending-contradiction','policy-contradiction','state-contradiction']){
  await page.evaluate(kind=>{window.statusWait=false;window.reply=request=>{let r={schemaVersion:'1.0.0',state:'ready',reason:'ready',binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId,policyRevision:request.policyRevision,contextRevision:request.contextRevision},local:{policyConfirmed:true,localChangePending:false,paused:false,requiresRebind:false,busy:false}};if(kind==='missing')return {};if(kind==='version')r.schemaVersion='2.0.0';if(kind==='binding')r.binding.sourceNamespace='00000000-0000-4000-8000-000000000099';if(kind==='flags')r.local.paused=0;if(kind==='reason')r.reason='invented';if(kind==='unavailable'){r.state='unavailable';r.reason='no_runtime';r.binding=null;r.local=null}if(kind==='paused-contradiction'){r.state='unavailable';r.reason='paused'}if(kind==='rebind-contradiction'){r.state='unavailable';r.reason='rebind_required'}if(kind==='pending-contradiction'){r.state='unavailable';r.reason='local_change_pending'}if(kind==='policy-contradiction'){r.state='unknown';r.reason='policy_unconfirmed'}if(kind==='state-contradiction'){r.state='unknown';r.reason='no_configuration';r.binding=null;r.local=null}return r}},alteration);
  await page.getByLabel('Health source').selectOption('');await page.getByLabel('Health source').selectOption('0');
  await page.waitForTimeout(20);assert.equal(await page.getByText('Local setup: Ready',{exact:true}).count(),0,alteration);
  if(alteration.endsWith('contradiction'))assert.equal(await page.getByText('Local setup: Status unknown',{exact:true}).isVisible(),true,alteration);
 }
 // Coherent native negative flags retain their distinct labels.
 for(const [reason,flag,text] of [['paused','paused','Paused'],['rebind_required','requiresRebind','Owner confirmation required'],['local_change_pending','localChangePending','Change awaiting confirmation']]){
  await page.evaluate(({reason,flag})=>{window.reply=request=>{const local={policyConfirmed:true,localChangePending:false,paused:false,requiresRebind:false,busy:false};local[flag]=true;return {schemaVersion:'1.0.0',state:'unavailable',reason,binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId,policyRevision:request.policyRevision,contextRevision:request.contextRevision},local}}},{reason,flag});
  await page.getByLabel('Health source').selectOption('');await page.getByLabel('Health source').selectOption('0');await page.getByText('Local setup: '+text,{exact:true}).waitFor();
 }
 // A-B-A must discard both earlier requests, even where A's tuple matches again.
 await page.evaluate(()=>{window.statusWait=true;window.pending=[]});
 await page.getByLabel('Health source').selectOption('1');await page.getByLabel('Health source').selectOption('0');await page.getByLabel('Health source').selectOption('1');
 await page.waitForFunction(()=>pending.length===3);
 await page.evaluate(()=>{const valid=p=>({schemaVersion:'1.0.0',state:'ready',reason:'ready',binding:{sourceNamespace:p.request.sourceNamespace,enrollmentId:p.request.enrollmentId,endpointId:p.request.endpointId,policyRevision:p.request.policyRevision,contextRevision:p.request.contextRevision},local:{policyConfirmed:true,localChangePending:false,paused:false,requiresRebind:false,busy:false}});pending[0].resolve(valid(pending[0]));pending[1].resolve(valid(pending[1]))});
 await page.waitForTimeout(20);assert.equal(await page.getByText('Local setup: Ready',{exact:true}).count(),0);
 await page.evaluate(()=>pending[2].resolve({schemaVersion:'1.0.0',state:'unavailable',reason:'no_configuration',binding:null,local:null}));await page.getByText('Local setup: Not configured on this phone',{exact:true}).waitFor();
 await page.getByLabel('Health source').selectOption('0');await page.waitForFunction(()=>pending.length===4);
 await page.evaluate(()=>{window.allowed=false;window.ui.invalidate();pending[3].resolve({schemaVersion:'1.0.0',state:'ready',reason:'ready',binding:pending[3].request,local:{policyConfirmed:true,localChangePending:false,paused:false,requiresRebind:false,busy:false}})});
 await page.waitForTimeout(20);assert.equal(await page.getByLabel('Health source').isVisible(),false);assert.equal(await page.getByText('Local setup: Ready',{exact:true}).count(),0);
 await page.evaluate(()=>{window.allowed=true;delete window.native.healthStatus;window.statusWait=false});
 await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');await page.getByText('Local setup: Status unavailable in this app version',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>calls),2,'selection never auto loads');
 await page.evaluate(()=>{window.native.healthStatus=request=>new Promise(resolve=>window.pending.push({request,resolve}))});
 // Existing controller currentness rejects late identity/endpoint/revision results.
 for(const field of ['ownerVersion','endpoint','contextRevision']){
  await page.evaluate(()=>{window.statusWait=true;window.pending=[];window.ui.invalidate()});
  await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');await page.waitForFunction(()=>pending.length===1);
  await page.evaluate(field=>{if(field==='endpoint')window.endpoint='60000000-0000-4000-8000-000000000099';else window[field]++;const request=pending[0].request;pending[0].resolve({schemaVersion:'1.0.0',state:'ready',reason:'ready',binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId,policyRevision:request.policyRevision,contextRevision:request.contextRevision},local:{policyConfirmed:true,localChangePending:false,paused:false,requiresRebind:false,busy:false}})},field);
  await page.waitForTimeout(20);assert.equal(await page.getByText('Local setup: Ready',{exact:true}).count(),0,field);
 }
 // Protective pause remains available even when status cannot be read.
 await page.evaluate(()=>{window.allowed=true;window.ui.invalidate();delete window.native.healthStatus;window.pauseCalls=[];window.resumeCalls=[];window.native.healthResumeCollection=request=>{resumeCalls.push(request);return new Promise(resolve=>window.resumeResolve=resolve)};window.native.healthPauseCollection=request=>{pauseCalls.push(request);return new Promise(resolve=>window.pauseResolve=resolve)}});
 await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');
 await page.getByText('Local setup: Status unavailable in this app version',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Pause collection on this phone',exact:true}).click();
 await page.waitForFunction(()=>pauseCalls.length===1);
 await page.getByRole('button',{name:'Requesting pause…',exact:true}).evaluate(button=>button.dispatchEvent(new Event('click')));
 assert.equal(await page.evaluate(()=>pauseCalls.length),1,'duplicate click suppressed');
 assert.equal(await page.getByText('Collection paused on this phone.',{exact:true}).count(),0,'no optimistic success');
 await page.evaluate(()=>{const r=pauseCalls[0];pauseResolve({schemaVersion:'1.0.0',operationId:r.operationId,binding:{sourceNamespace:r.sourceNamespace,enrollmentId:r.enrollmentId,endpointId:r.endpointId},persistence:'savedPaused',drain:'pending',reason:'paused'});native.healthPauseCollection=request=>{pauseCalls.push(request);return Promise.resolve({schemaVersion:'1.0.0',operationId:request.operationId,binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId},persistence:'savedPaused',drain:'drained',reason:'paused'})}});
 await page.getByText('Pause saved. In-flight work is still stopping.',{exact:true}).waitFor();await page.getByRole('button',{name:'Check pause status',exact:true}).click();
 await page.getByText('Collection paused on this phone.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>pauseCalls[0].operationId===pauseCalls[1].operationId),true,'explicit check reuses original ID');
 // Resume is an explicit action bound to that exact native pause ID, not sync.
 await page.getByRole('button',{name:'Resume collection on this phone',exact:true}).click();
 await page.waitForFunction(()=>resumeCalls.length===1);
 await page.getByRole('button',{name:'Resuming…',exact:true}).evaluate(button=>button.dispatchEvent(new Event('click')));
 assert.equal(await page.evaluate(()=>resumeCalls.length),1,'resume duplicate click suppressed');
 assert.equal(await page.getByText('Collection is enabled for the configured categories on this phone. No data was synced by this action.',{exact:true}).count(),0,'no optimistic resume');
 assert.equal(await page.evaluate(()=>resumeCalls[0].expectedPauseOperationId===pauseCalls[0].operationId),true);
 assert.equal(await page.evaluate(()=>Object.hasOwn(resumeCalls[0],'selection')),false,'no JS native selector');
 await page.evaluate(()=>{const r=resumeCalls[0];resumeResolve({schemaVersion:'1.0.0',operationId:r.operationId,binding:{sourceNamespace:r.sourceNamespace,enrollmentId:r.enrollmentId,endpointId:r.endpointId,policyRevision:1},outcome:'resumed',reason:'resumed'})});
 await page.getByText('Collection is enabled for the configured categories on this phone. No data was synced by this action.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Collection paused on this phone.',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Pause collection on this phone',exact:true}).click();await page.waitForFunction(()=>pauseCalls.length===3);
 assert.equal(await page.evaluate(()=>pauseCalls[2].operationId!==pauseCalls[0].operationId),true,'new pause uses new ID after resume');
 // A late response belongs to its original source and cannot label a new one.
 await page.evaluate(()=>{ui.invalidate();window.pauseCalls=[];native.healthPauseCollection=request=>{pauseCalls.push(request);return new Promise(resolve=>window.pauseResolve=resolve)}});
 await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');await page.getByRole('button',{name:'Pause collection on this phone',exact:true}).click();await page.waitForFunction(()=>pauseCalls.length===1);
 await page.getByLabel('Health source').selectOption('1');
 await page.evaluate(()=>{const r=pauseCalls[0];pauseResolve({schemaVersion:'1.0.0',operationId:r.operationId,binding:{sourceNamespace:r.sourceNamespace,enrollmentId:r.enrollmentId,endpointId:r.endpointId},persistence:'unconfirmed',drain:'pending',reason:'storage_unconfirmed'})});
 await page.waitForTimeout(20);assert.equal(await page.getByText('Collection is blocked for now. The saved pause is unconfirmed and in-flight work is still stopping.',{exact:true}).count(),0,'late source response discarded');
 await page.getByLabel('Health source').selectOption('0');await page.getByText('Collection is blocked for now. The saved pause is unconfirmed and in-flight work is still stopping.',{exact:true}).waitFor();
 await page.evaluate(()=>{native.healthPauseCollection=request=>{pauseCalls.push(request);return Promise.resolve({schemaVersion:'1.0.0',operationId:request.operationId,binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId},persistence:'unconfirmed',drain:'drained',reason:'storage_unconfirmed'})}});
 await page.getByRole('button',{name:'Check pause status',exact:true}).click();await page.getByText('Collection is blocked for now. The saved pause is unconfirmed.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>pauseCalls[0].operationId===pauseCalls[1].operationId),true);
 // Wrong operation/source replies never claim success and are not retried.
 await page.evaluate(()=>{ui.invalidate();native.healthPauseCollection=request=>Promise.resolve({schemaVersion:'1.0.0',operationId:'00000000-0000-4000-8000-000000000099',binding:null,persistence:'savedPaused',drain:'drained',reason:'paused'})});
 await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');await page.getByRole('button',{name:'Pause collection on this phone',exact:true}).click();await page.getByText('The pause result is unavailable. No saved or stopped state is confirmed.',{exact:true}).waitFor();
 // Unknown/late Resume responses do not enable a newly selected source.
 await page.evaluate(()=>{ui.invalidate();window.resumeCalls=[];native.healthPauseCollection=request=>Promise.resolve({schemaVersion:'1.0.0',operationId:request.operationId,binding:{sourceNamespace:request.sourceNamespace,enrollmentId:request.enrollmentId,endpointId:request.endpointId},persistence:'savedPaused',drain:'drained',reason:'paused'});native.healthResumeCollection=request=>{resumeCalls.push(request);return new Promise(resolve=>window.resumeResolve=resolve)}});
 await page.getByRole('button',{name:'Load connections'}).click();await page.getByLabel('Health source').selectOption('0');await page.getByRole('button',{name:'Pause collection on this phone',exact:true}).click();await page.getByRole('button',{name:'Resume collection on this phone',exact:true}).click();await page.waitForFunction(()=>resumeCalls.length===1);
 await page.getByLabel('Health source').selectOption('1');
 await page.evaluate(()=>{const r=resumeCalls[0];resumeResolve({schemaVersion:'1.0.0',operationId:r.operationId,binding:{sourceNamespace:r.sourceNamespace,enrollmentId:r.enrollmentId,endpointId:r.endpointId,policyRevision:1},outcome:'unconfirmed',reason:'storage_unconfirmed'})});
 await page.waitForTimeout(20);assert.equal(await page.getByText('Resume is unconfirmed. Further collection remains held; Pause is still available.',{exact:true}).count(),0);
 await page.getByLabel('Health source').selectOption('0');await page.getByText('Resume is unconfirmed. Further collection remains held; Pause is still available.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Pause collection on this phone',exact:true}).isEnabled(),true,'protective pause remains available');
 await page.evaluate(()=>{native.healthResumeCollection=request=>{resumeCalls.push(request);return Promise.resolve({schemaVersion:'1.0.0',operationId:request.operationId,binding:null,outcome:'resumed',reason:'resumed'})}});
 await page.getByRole('button',{name:'Check resume status',exact:true}).click();await page.getByText('Resume could not be confirmed. No enabled state is confirmed.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>resumeCalls[1].operationId===resumeCalls[0].operationId),true,'check reuses same resume ID');
 assert.equal(await page.evaluate(()=>mutationCalls),0,'status never invokes operational methods');
});

test('prepared native Health choices keep setup, OS request and sync separate and truthful',{timeout:60000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 const dir=await mkdtemp(join(tmpdir(),'health-setup-ui-')),entry=join(dir,'entry.js');
 await writeFile(entry,`import {createHealthInventoryView} from ${JSON.stringify(fileURLToPath(new URL('../web/health-inventory-view.js',import.meta.url)))};
 const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
 window.ownerVersion=1;window.allowed=true;window.calls=[];window.holdCatalog=false;
 window.catalog={schemaVersion:'1.0.0',state:'available',reason:'ready',catalogId:id(1),choices:[2,3].map(n=>({choice:id(n),label:'Configured Health '+n,destinationLabel:'Original private server',setupScope:'existingRemoteOnThisPhone',useInspection:'notChecked',dataChoices:[{categoryChoice:id(n+10),label:'Sleep'}]}))};
 window.reply=(kind,request,value)=>({schemaVersion:'1.0.0',operation:kind,catalogId:request.catalogId,choice:request.choice,attemptId:id(99),reason:kind==='sync'&&value==='deferred'?'sync_deferred':kind==='setup'&&value==='notConfirmed'?'operation_unconfirmed':'ready',readKnowledge:'unknown',[{setup:'setupOutcome',permission:'requestState',sync:'syncOutcome'}[kind]]:value});
 window.native={healthInventory:async()=>({sources:[],unboundEnrollments:[]}),healthSetupChoices:request=>{calls.push({kind:'catalog',request});return holdCatalog?new Promise(resolve=>window.finishCatalog=resolve):Promise.resolve(catalog)},healthSetupChoice:request=>{calls.push({kind:'setup',request});return new Promise(resolve=>window.finishSetup=value=>resolve(reply('setup',request,value)))},healthRequestReadPermission:request=>{calls.push({kind:'permission',request});return new Promise(resolve=>window.finishPermission=value=>resolve(reply('permission',request,value)))},healthSyncChoice:request=>{calls.push({kind:'sync',request});return new Promise(resolve=>window.finishSync=value=>resolve(reply('sync',request,value)))}};
 window.ui=createHealthInventoryView({root:document.querySelector('#root'),native,owner:()=>allowed?{version:ownerVersion}:null,current:value=>allowed&&value.version===ownerVersion});`);
 await build({entryPoints:[entry],outfile:join(dir,'bundle.js'),bundle:true,platform:'browser'});
 const browser=await chromium.launch({channel:'chrome'});t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true})});
 const page=await browser.newPage();page.setDefaultTimeout(4000);await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});
 const load=page.getByRole('button',{name:'Load prepared connections',exact:true}),source=page.getByLabel('Prepared Health connection',{exact:true});
 const setup=page.getByRole('button',{name:'Prepare on this phone',exact:true}),permission=page.getByRole('button',{name:'Request Apple Health access',exact:true}),sync=page.getByRole('button',{name:'Sync now',exact:true});
 assert.equal(await page.evaluate(()=>calls.length),0,'no automatic catalog or effect');
 await load.click();await source.selectOption('0');assert.equal(await page.evaluate(()=>calls.length),1,'choosing is metadata only');
 await page.getByText('Destination: Original private server',{exact:true}).waitFor();await page.getByText('Effective use and Assistant access are not checked here. Your existing settings are unchanged. Apple Health read access and history coverage remain unknown.',{exact:true}).waitFor();
 assert.equal(await permission.isDisabled(),true);assert.equal(await sync.isDisabled(),true);
 await setup.click();await page.waitForFunction(()=>calls.at(-1).kind==='setup');
 assert.deepEqual(await page.evaluate(()=>Object.keys(calls.at(-1).request).sort()),['catalogId','choice']);assert.equal(await load.isDisabled(),true);
 await setup.evaluate(button=>button.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.filter(v=>v.kind==='setup').length),1,'untrusted/duplicate effect blocked');
 await page.evaluate(()=>finishSetup('prepared'));await page.getByText('Local setup is prepared. Apple Health read access is still unknown. Request access or sync only with a separate action.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>calls.filter(v=>v.kind==='permission'||v.kind==='sync').length),0,'setup never chains access or sync');
 await permission.click();await page.waitForFunction(()=>calls.at(-1).kind==='permission');assert.equal(await sync.isDisabled(),true);
 await page.evaluate(()=>finishPermission('completedReadNotObservable'));await page.getByText('The Apple Health request completed. Apple does not report whether read access was granted. No data was synced.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Connected',{exact:true}).count(),0);assert.equal(await page.evaluate(()=>calls.filter(v=>v.kind==='sync').length),0);
 await page.getByLabel('Data to sync',{exact:true}).selectOption('0');
 const messages={idle:'There are no pending changes to send. Readable data and history coverage remain unknown.',applied:'Changes were acknowledged. This does not establish complete history or a successful answer.',retry:'Sync needs a retry. Pending changes remain governed by the existing connection.',needsAttention:'Some changes need attention.',invalidReceipt:'The server receipt could not be confirmed.',deferred:'Sync was deferred. Existing settings remain unchanged.'};
 for(const [outcome,text] of Object.entries(messages)){await sync.click();await page.waitForFunction(()=>calls.at(-1).kind==='sync');await page.evaluate(value=>finishSync(value),outcome);await page.getByText(text,{exact:true}).waitFor()}
 assert.equal(await page.evaluate(()=>calls.filter(v=>v.kind==='permission').length),1,'ordinary sync never repeats permission');
 assert.deepEqual(await page.evaluate(()=>Object.keys(calls.at(-1).request).sort()),['catalogId','categoryChoice','choice']);
 // A-B-A picker changes invalidate the old completion even with the same opaque handle.
 await page.evaluate(()=>ui.invalidate());await load.click();await source.selectOption('0');await setup.click();await page.waitForFunction(()=>typeof finishSetup==='function');
 await source.evaluate(select=>{select.value='1';select.dispatchEvent(new Event('change'));select.value='0';select.dispatchEvent(new Event('change'))});await page.evaluate(()=>finishSetup('prepared'));await page.waitForFunction(()=>!document.querySelector('button[data-operation="setup"]').disabled);
 assert.equal(await permission.isDisabled(),true,'old prepared result not adopted after picker ABA');
 // Unknown/failed setup never enables permission and never automatically retries.
 await setup.click();await page.evaluate(()=>finishSetup('notConfirmed'));await page.getByText('Local setup is not confirmed. No permission request or sync was started by this action.',{exact:true}).waitFor();assert.equal(await permission.isDisabled(),true);assert.equal(await setup.isDisabled(),true);
 // Contradictory positive action replies cannot claim preparation or an acknowledgment.
 for(const alteration of ['sync-reason','setup-reason','sync-attempt','setup-read','sync-binding','setup-extra']){
  await page.evaluate(alteration=>{
   ui.invalidate();native.healthSetupChoices=()=>Promise.resolve(catalog);
   native.healthSetupChoice=request=>{const value=reply('setup',request,'prepared');if(alteration==='setup-reason')value.reason='cancelled';if(alteration==='setup-read')value.readKnowledge='granted';if(alteration==='setup-extra')value.granted=true;return Promise.resolve(value)};
   native.healthSyncChoice=request=>{const value=reply('sync',request,'applied');if(alteration==='sync-reason')value.reason='context_changed';if(alteration==='sync-attempt')value.attemptId=null;if(alteration==='sync-binding')value.choice='00000000-0000-4000-8000-000000000098';return Promise.resolve(value)};
  },alteration);
  await load.click();await source.selectOption('0');await setup.click();
  if(alteration.startsWith('sync')){await page.getByText('Local setup is prepared. Apple Health read access is still unknown. Request access or sync only with a separate action.',{exact:true}).waitFor();await page.getByLabel('Data to sync',{exact:true}).selectOption('0');await sync.click()}
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('p')).some(p=>['The result could not be confirmed. No new setup, access or sync state is confirmed.','Changes were acknowledged. This does not establish complete history or a successful answer.'].includes(p.textContent)));
  assert.equal(await page.getByText('Changes were acknowledged. This does not establish complete history or a successful answer.',{exact:true}).count(),0,alteration+' must not claim acknowledgment');
  await page.getByText('The result could not be confirmed. No new setup, access or sync state is confirmed.',{exact:true}).waitFor();
 }
 // Malformed fresh catalog must not provide action handles or labels.
 for(const kind of ['extra','grant','destination','overflow','duplicate','raw-category']){
  await page.evaluate(kind=>{ui.invalidate();window.native.healthSetupChoices=()=>{const value=structuredClone(catalog);if(kind==='extra')value.granted=true;if(kind==='grant')value.choices[0].useInspection='permitted';if(kind==='destination')value.choices[0].destinationLabel='';if(kind==='overflow')value.choices=Array(9).fill(value.choices[0]);if(kind==='duplicate')value.choices[1].choice=value.choices[0].choice;if(kind==='raw-category')value.choices[0].dataChoices[0].category='sleep';return Promise.resolve(value)}},kind);
  await load.click();await page.getByText('Prepared connection details could not be confirmed.',{exact:true}).waitFor();assert.equal(await source.isVisible(),false,kind);
 }
 // Owner/pane protection clears UI tokens; a late native response cannot resurrect them.
 await page.evaluate(()=>{ui.invalidate();native.healthSetupChoices=()=>new Promise(resolve=>window.finishCatalog=resolve)});await load.click();await page.waitForFunction(()=>typeof finishCatalog==='function');await page.evaluate(()=>{allowed=false;ownerVersion++;ui.invalidate();finishCatalog(catalog)});await page.waitForTimeout(20);
 assert.equal(await source.isVisible(),false);assert.equal(await page.getByText('Destination: Original private server',{exact:true}).count(),0);
});
