import {createHealthRemoteSetupView} from './health-remote-setup-view.js';
import {createHealthSourceConsentView} from './health-source-consent-view.js';
// Owner-scoped discovery, protective controls and separate explicit local actions; no automatic permission or sync.
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const integer=(value,min)=>Number.isSafeInteger(value)&&value>=min;
const keys=(value,expected)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
const bindingKeys=['sourceNamespace','enrollmentId','endpointId','policyRevision','contextRevision'];
const localKeys=['policyConfirmed','localChangePending','paused','requiresRebind','busy'];
const reasons=new Set(['ready','invalid_request','no_configuration','no_runtime','draining','context_unavailable','context_changed','inventory_unavailable','source_mismatch','proof_unavailable','policy_unconfirmed','local_change_pending','paused','rebind_required','storage_unavailable']);
function validReply(value,hint){
 if(!keys(value,['schemaVersion','state','reason','binding','local'])||value.schemaVersion!=='1.0.0'||!['ready','unavailable','unknown'].includes(value.state)||!reasons.has(value.reason))return false;
 if(value.binding!==null&&(!keys(value.binding,bindingKeys)||!bindingKeys.every(key=>value.binding[key]===hint[key])))return false;
 if(value.local!==null&&(!keys(value.local,localKeys)||value.binding===null||!localKeys.every(key=>typeof value.local[key]==='boolean')))return false;
 if(value.state==='ready')return value.reason==='ready'&&value.binding!==null&&value.local!==null&&value.local.policyConfirmed&&!value.local.localChangePending&&!value.local.paused&&!value.local.requiresRebind;
 const legalState={invalid_request:'unavailable',no_configuration:'unavailable',no_runtime:'unavailable',draining:'unavailable',context_changed:'unavailable',inventory_unavailable:'unknown',source_mismatch:'unavailable',proof_unavailable:'unknown',policy_unconfirmed:'unknown',local_change_pending:'unavailable',paused:'unavailable',rebind_required:'unavailable',storage_unavailable:'unavailable'};
 if(value.reason==='context_unavailable'){if(!['unknown','unavailable'].includes(value.state))return false}
 else if(legalState[value.reason]!==value.state)return false;
 const flag={paused:'paused',rebind_required:'requiresRebind',local_change_pending:'localChangePending'}[value.reason];
 if(flag&&value.local?.[flag]!==true)return false;
 if(value.reason==='policy_unconfirmed'&&value.local?.policyConfirmed!==false)return false;
 if(value.reason==='proof_unavailable'&&(!value.local?.policyConfirmed||value.local.localChangePending||value.local.paused||value.local.requiresRebind))return false;
 return true;
}
const pauseBindingKeys=['sourceNamespace','enrollmentId','endpointId'];
const newOperationId=()=>{
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
function validPauseReply(value,request){
 if(!keys(value,['schemaVersion','operationId','binding','persistence','drain','reason'])||value.schemaVersion!=='1.0.0'||value.operationId!==request.operationId)return false;
 if(value.binding!==null&&(!keys(value.binding,pauseBindingKeys)||!pauseBindingKeys.every(key=>value.binding[key]===request[key])))return false;
 if(value.persistence==='savedPaused')return value.binding!==null&&['paused','already_paused'].includes(value.reason)&&['pending','drained'].includes(value.drain);
 if(value.persistence==='unconfirmed')return value.binding!==null&&value.reason==='storage_unconfirmed'&&['pending','drained'].includes(value.drain);
 return value.persistence==='notApplied'&&value.drain==='notStarted'&&['no_local_binding','context_changed','source_mismatch','busy','prior_unconfirmed','invalid_request'].includes(value.reason);
}
function pauseMessage(value){
 if(value.persistence==='savedPaused')return value.drain==='drained'?'Collection paused on this phone.':'Pause saved. In-flight work is still stopping.';
 if(value.persistence==='unconfirmed')return value.drain==='drained'?'Collection is blocked for now. The saved pause is unconfirmed.':'Collection is blocked for now. The saved pause is unconfirmed and in-flight work is still stopping.';
 return {no_local_binding:'No known local setup is available to pause.',context_changed:'The local state or session changed. No new pause was applied.',source_mismatch:'This source does not match the local setup. No pause was applied.',busy:'Another local pause is in progress.',prior_unconfirmed:'An earlier pause is still unconfirmed.',invalid_request:'The pause request could not be validated.'}[value.reason]??'No pause was applied.';
}
function validResumeReply(value,request){
 if(!keys(value,['schemaVersion','operationId','binding','outcome','reason'])||value.schemaVersion!=='1.0.0'||value.operationId!==request.operationId)return false;
 if(value.binding!==null&&(!keys(value.binding,[...pauseBindingKeys,'policyRevision'])||!pauseBindingKeys.every(key=>value.binding[key]===request[key])||!integer(value.binding.policyRevision,1)))return false;
 if(value.outcome==='resumed')return value.reason==='resumed'&&value.binding!==null;
 if(value.outcome==='unconfirmed')return ['storage_unconfirmed','context_changed'].includes(value.reason);
 return value.outcome==='notApplied'&&['invalid_request','no_known_pause','pause_changed','pause_pending','busy','context_changed','policy_unavailable','source_mismatch','categories_changed'].includes(value.reason);
}
function resumeMessage(value){
 if(value.outcome==='resumed')return 'Collection is enabled for the configured categories on this phone. No data was synced by this action.';
 if(value.outcome==='unconfirmed')return 'Resume is unconfirmed. Further collection remains held; Pause is still available.';
 return {policy_unavailable:'Current server policy does not permit this resume.',categories_changed:'The configured categories are no longer permitted.',pause_changed:'The original local pause has changed.',pause_pending:'Wait for the saved pause to finish stopping.',busy:'A resume request is already in progress.',context_changed:'The local state or session changed. Resume was not confirmed.'}[value.reason]??'No resume was applied.';
}
export function createHealthInventoryView({root,native,owner,current,assistants=()=>[]}) {
 let generation=0,selectionGeneration=0,sources=[],loadedIdentity=null,pauseRecord=null,sourceConsent=null;
 const element=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const status=element('p','Choose Load connections to review your existing sources.');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const load=element('button','Load connections');load.type='button';load.className='secondary';
 const label=element('label','Health source'),select=element('select'),detail=element('div');label.append(select);label.hidden=true;root.replaceChildren(element('p','Review sources available to your account. Loading this list does not start collection.'),load,status,label,detail);
 const remoteRoot=element('section');const remote=typeof native.healthRemoteSetupOptions==='function'?createHealthRemoteSetupView({root:remoteRoot,native,owner,current,assistants}):null;if(remote)root.append(remoteRoot);
 const recoveryRoot=element('section');const recovery=typeof native.healthSavedRecoveryChoice==='function'?createHealthSavedRecoveryView({root:recoveryRoot,native,owner,current}):null;if(recovery)root.append(recoveryRoot);
 const preparedRoot=element('section');const prepared=typeof native.healthSetupChoices==='function'?createPreparedHealthView({root:preparedRoot,native,owner,current}):null;if(prepared)root.append(preparedRoot);
 function clear(){sourceConsent?.invalidate();sourceConsent=null;selectionGeneration++;loadedIdentity=null;sources=[];select.replaceChildren();label.hidden=true;detail.replaceChildren()}
 function render(){
  sourceConsent?.invalidate();sourceConsent=null;
  const selected=++selectionGeneration;
  if(!loadedIdentity||!current(loadedIdentity)){invalidate();status.textContent='Session changed. Load connections again.';return}
  detail.replaceChildren();if(select.value==='')return;
  const index=Number(select.value);if(!Number.isInteger(index)||index<0||index>=sources.length)return;
  const source=sources[index],identity=loadedIdentity;
  const server=source.currentState==='active'?'Active':source.currentState==='disconnected'?'Disconnected':source.currentEnrollmentId?'Awaiting setup':'No enrollment on this phone';
  const names={SleepSegment:'Sleep',heartRate:'Heart rate',restingHeartRate:'Resting heart rate',respiratoryRate:'Respiratory rate',hrvSDNN:'Heart rate variability (SDNN)',hrvRMSSD:'Heart rate variability (RMSSD)'};
  const localStatus=element('p','Local setup: Checking…');localStatus.setAttribute('role','status');localStatus.setAttribute('aria-live','polite');
  detail.append(element('p',`Server enrollment: ${server}`),localStatus,element('p',`Collection setting: ${source.collectionPaused?'Paused':'Not paused'}`),element('p',`Use setting: ${source.usePaused?'Paused':'Not paused'}`),element('p',`Selected data: ${(Array.isArray(source.categories)?source.categories:[]).map(x=>names[x]??x).join(', ')||'None'}`),element('p',`Recorded use choices: ${(Array.isArray(source.uses)?source.uses:[]).join(', ')||'None'}`),element('p',`Recorded Assistant choices: ${Array.isArray(source.assistantIds)?source.assistantIds.length:0}`),element('p','Coverage: unknown'));
  if(source.preferredSource)detail.append(element('p',`Preferred source: ${source.preferredSource}`));
  detail.append(element('p','Local readiness does not establish Health permission or data coverage.'),element('p','Effective use and Assistant access are not checked here. Your existing settings are unchanged.'));
  if(typeof native.healthLoadSourceConsent==='function'&&source.currentEnrollmentId){const consentRoot=element('section');detail.append(consentRoot);sourceConsent=createHealthSourceConsentView({root:consentRoot,native,owner:()=>identity,current:job=>selected===selectionGeneration&&current(job),source:()=>source})}
  if(typeof native.healthPrepareExistingSource==='function'&&source.currentEnrollmentId&&source.currentState==='active'){
   const preparation=element('section');detail.append(preparation);
   createExistingHealthPreparation({root:preparation,native,source,identity,live:()=>selected===selectionGeneration&&identity===loadedIdentity&&current(identity)&&select.value===String(index),onPrepared:()=>prepared?.invalidate()});
  }
  const pauseTarget={sourceNamespace:source.sourceNamespace,enrollmentId:source.currentEnrollmentId,endpointId:identity.endpointId};
  const targetKey=JSON.stringify(pauseTarget),pauseButton=element('button','Pause collection on this phone'),pauseNote=element('p'),resumeButton=element('button','Resume collection on this phone'),resumeNote=element('p');pauseButton.type='button';pauseButton.className='secondary';pauseNote.setAttribute('role','status');resumeButton.type='button';resumeButton.className='secondary';resumeButton.hidden=true;resumeNote.setAttribute('role','status');
  detail.append(element('p','Pause stops new collection and queued Health sending from this phone. Previously stored data and separately permitted uses remain. Other devices and OS permissions are unchanged; requests already sent may finish.'),pauseButton,pauseNote,resumeButton,resumeNote);
  const sameRecord=()=>pauseRecord&&pauseRecord.key===targetKey&&current(pauseRecord.owner);
  const pauseLive=()=>selected===selectionGeneration&&identity===loadedIdentity&&current(identity)&&select.value===String(index);
  function showPause(){
   const supported=typeof native.healthPauseCollection==='function'&&typeof crypto.getRandomValues==='function'&&pauseBindingKeys.every(key=>uuid(pauseTarget[key]));
   const record=sameRecord()?pauseRecord:null;
   const otherHeld=pauseRecord&&!record&&current(pauseRecord.owner)&&(pauseRecord.pending||pauseRecord.result?.persistence==='unconfirmed'||pauseRecord.result?.drain==='pending');
   pauseButton.disabled=!supported||!!otherHeld||!!record?.pending||!!record?.unknown;
   pauseButton.textContent=record?.pending?'Requesting pause…':record?.result&&!record.superseded?'Check pause status':'Pause collection on this phone';
   if(!supported)pauseNote.textContent='Local pause is unavailable for this source in this app version.';
   else if(otherHeld)pauseNote.textContent='An earlier local pause is still being checked.';
   else if(record?.unknown)pauseNote.textContent='The pause result is unavailable. No saved or stopped state is confirmed.';
   else if(record?.resume&&record.superseded)pauseNote.textContent='The previous pause is no longer a current-state confirmation.';
   else if(record?.result)pauseNote.textContent=pauseMessage(record.result);
   else if(record?.pending)pauseNote.textContent='Requesting a local pause…';
   showResume();
  }
  function showResume(){
   const record=sameRecord()?pauseRecord:null,observation=record?.resume;
   const eligible=record?.result?.persistence==='savedPaused'&&record?.result?.drain==='drained'&&(!record.superseded||!!observation);
   resumeButton.hidden=typeof native.healthResumeCollection!=='function'||!eligible;
   resumeButton.disabled=!!observation?.pending||observation?.result?.outcome==='resumed';
   resumeButton.textContent=observation?.pending?'Resuming…':observation?.unknown||observation?.result?.outcome==='unconfirmed'?'Check resume status':'Resume collection on this phone';
   resumeNote.textContent=observation?.pending?'Checking current permission to resume…':observation?.unknown?'Resume could not be confirmed. No enabled state is confirmed.':observation?.result?resumeMessage(observation.result):'';
  }
  resumeButton.addEventListener('click',()=>{
   if(resumeButton.hidden||resumeButton.disabled||!pauseLive()||!sameRecord())return;
   const record=pauseRecord;
   let observation=record.resume;
   if(!observation||observation.result?.outcome==='notApplied'){
    observation={request:{schemaVersion:'1.0.0',operationId:newOperationId(),expectedPauseOperationId:record.request.operationId,...pauseTarget},pending:false,result:null,unknown:false};record.resume=observation;
   }
   observation.pending=true;record.superseded=true;showPause();
   Promise.resolve().then(()=>current(record.owner)?native.healthResumeCollection(observation.request):null).then(value=>{
    if(!current(record.owner))return;observation.pending=false;
    if(validResumeReply(value,observation.request)){observation.result=value;observation.unknown=false}else observation.unknown=true;
    if(pauseLive()&&pauseRecord===record)showPause();
   }).catch(()=>{if(!current(record.owner))return;observation.pending=false;observation.unknown=true;if(pauseLive()&&pauseRecord===record)showPause()});
  });
  showPause();
  pauseButton.addEventListener('click',()=>{
   if(pauseButton.disabled||!pauseLive())return;
   let record=sameRecord()?pauseRecord:null;
   if(record?.superseded)record=null;
   if(!record){record={key:targetKey,owner:identity,request:{schemaVersion:'1.0.0',operationId:newOperationId(),...pauseTarget},pending:false,result:null,unknown:false};pauseRecord=record;}
   record.pending=true;showPause();
   Promise.resolve().then(()=>current(record.owner)?native.healthPauseCollection(record.request):null).then(value=>{
    if(!current(record.owner))return;
    record.pending=false;
    if(validPauseReply(value,record.request)){record.result=value;record.superseded=value.persistence==='notApplied'&&value.reason==='context_changed'}else record.unknown=true;
    if(pauseLive()&&sameRecord()&&pauseRecord===record)showPause();
   }).catch(()=>{if(!current(record.owner))return;record.pending=false;record.unknown=true;if(pauseLive()&&sameRecord()&&pauseRecord===record)showPause()});
  });
  if(typeof native.healthStatus!=='function'){localStatus.textContent='Local setup: Status unavailable in this app version';return}
  const hint={schemaVersion:'1.0.0',sourceNamespace:source.sourceNamespace,enrollmentId:source.currentEnrollmentId,endpointId:identity.endpointId,policyRevision:source.policyRevision,contextRevision:identity.revision};
  if(!uuid(hint.sourceNamespace)||!uuid(hint.enrollmentId)||!uuid(hint.endpointId)||!integer(hint.policyRevision,1)||!integer(hint.contextRevision,0)){localStatus.textContent='Local setup: Status unknown';return}
  const live=()=>selected===selectionGeneration&&identity===loadedIdentity&&current(identity)&&select.value===String(index);
  Promise.resolve().then(()=>live()?native.healthStatus(hint):null).then(value=>{
   if(!live())return;
   if(!validReply(value,hint)){localStatus.textContent='Local setup: Status unknown';return}
   const descriptions={ready:'Ready',no_configuration:'Not configured on this phone',no_runtime:'Not set up on this phone',draining:'Stopping',policy_unconfirmed:'Policy not confirmed',paused:'Paused',rebind_required:'Owner confirmation required',local_change_pending:'Change awaiting confirmation',storage_unavailable:'Storage unavailable'};
   localStatus.textContent=`Local setup: ${descriptions[value.reason]??'Status unknown'}`;
  }).catch(()=>{if(live())localStatus.textContent='Local setup: Status unknown'});
 }
 select.addEventListener('change',render);
 load.addEventListener('click',async()=>{const ticket=++generation,identity=owner();clear();if(!identity){status.textContent='Sign in to review your connections.';return}if(typeof native.healthInventory!=='function'){status.textContent='Health connections are unavailable in this app version.';return}load.disabled=true;status.textContent='Loading connections…';try{const result=await native.healthInventory();if(ticket!==generation||!current(identity))return;const list=Array.isArray(result?.sources)?result.sources.filter(s=>s?.collector==='healthKit'):[];sources=list;loadedIdentity=identity;select.append(new Option('Choose a source',''));for(let i=0;i<list.length;i++)select.append(new Option(`Health source ${i+1}`,String(i)));label.hidden=!list.length;const unbound=Array.isArray(result?.unboundEnrollments)?result.unboundEnrollments.filter(e=>e?.collector==='healthKit').length:0;status.textContent=list.length?`${list.length} health ${list.length===1?'source':'sources'} available. Choose one to review.`:unbound?'Health setup is not connected on this phone.':'No health sources were returned.';}catch{if(ticket===generation&&current(identity))status.textContent='Connection details are unavailable. Check your connection and try again.';}finally{if(ticket===generation)load.disabled=false}});
 function invalidate(){recovery?.invalidate();remote?.invalidate();prepared?.invalidate();generation++;load.disabled=false;pauseRecord=null;clear();status.textContent='Choose Load connections to review your existing sources.'}
 return {invalidate};
}

const setupReasons=new Set(['ready','not_started','busy','context_unavailable','context_changed','source_unavailable','policy_unavailable','policy_changed','local_setup_required','already_local','storage_unavailable','unsupported','request_failed','cancelled','operation_unconfirmed','sync_deferred']);
const catalogReasons=new Set(['ready','no_configuration','busy','context_unavailable','context_changed','inventory_unavailable','invalid_choice','owner_unavailable']);
const planLabels=new Set(['Sleep','Heart rate','Resting heart rate','Respiratory rate','HRV (SDNN)']);
const utf8Length=value=>new TextEncoder().encode(value).length;
const setupLabel=value=>typeof value==='string'&&value.length>0&&Array.from(value).length<=120&&utf8Length(value)<=512&&!/[\u0000-\u001f]/u.test(value);
function setupCatalog(value){
 if(!keys(value,['schemaVersion','state','reason','catalogId','choices'])||value.schemaVersion!=='1.0.0'||!catalogReasons.has(value.reason)||!Array.isArray(value.choices)||utf8Length(JSON.stringify(value))>32768)return false;
 if(value.state!=='available')return ['unavailable','unknown'].includes(value.state)&&value.reason!=='ready'&&value.catalogId===null&&value.choices.length===0;
 if(value.reason!=='ready'||!uuid(value.catalogId)||value.choices.length<1||value.choices.length>8)return false;
 const handles=new Set([value.catalogId]);
 for(const choice of value.choices){
  if(!(keys(choice,['choice','label','destinationLabel','setupScope','useInspection','dataChoices'])||keys(choice,['choice','label','destinationLabel','setupScope','localSetup','useInspection','dataChoices'])&&['prepareNewLocal','confirmSavedLocal','configuredLocalConfirmed'].includes(choice.localSetup))||!uuid(choice.choice)||handles.has(choice.choice)||!setupLabel(choice.label)||!setupLabel(choice.destinationLabel)||choice.setupScope!=='existingRemoteOnThisPhone'||choice.useInspection!=='notChecked'||!Array.isArray(choice.dataChoices)||choice.dataChoices.length<1||choice.dataChoices.length>5)return false;
  handles.add(choice.choice);const names=new Set();
  for(const plan of choice.dataChoices){if(!keys(plan,['categoryChoice','label'])||!uuid(plan.categoryChoice)||handles.has(plan.categoryChoice)||!planLabels.has(plan.label)||names.has(plan.label))return false;handles.add(plan.categoryChoice);names.add(plan.label)}
 }
 return true;
}
function setupReply(value,kind,request){
 const field={setup:'setupOutcome',permission:'requestState',sync:'syncOutcome'}[kind];
 if(!keys(value,['schemaVersion','operation','catalogId','choice','attemptId','reason','readKnowledge',field])||value.schemaVersion!=='1.0.0'||value.operation!==kind||value.readKnowledge!=='unknown'||!setupReasons.has(value.reason)||utf8Length(JSON.stringify(value))>4096)return false;
 if(value.attemptId!==null&&!uuid(value.attemptId))return false;
 const same=value.catalogId===request.catalogId&&value.choice===request.choice;
 if(!same&&(value.catalogId!==null||value.choice!==null))return false;
 if(kind==='setup'){if(!['prepared','notInvoked','notConfirmed'].includes(value[field]))return false;if(value[field]==='prepared')return same&&uuid(value.attemptId)&&value.reason==='ready';if(value.reason==='ready')return false}
 if(kind==='permission'){if(!['completedReadNotObservable','notInvoked','unsupported','deferred'].includes(value[field]))return false;if(value[field]==='completedReadNotObservable')return same&&uuid(value.attemptId)&&value.reason==='ready';if(value.reason==='ready'||value[field]==='unsupported'&&value.reason!=='unsupported')return false}
 if(kind==='sync'){if(value[field]!==null&&!['idle','applied','retry','needsAttention','invalidReceipt','deferred'].includes(value[field]))return false;if(value[field]!==null)return same&&uuid(value.attemptId)&&value.reason===(value[field]==='deferred'?'sync_deferred':'ready');if(value.reason==='ready')return false}
 return true;
}
function createPreparedHealthView({root,native,owner,current}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const load=el('button','Load prepared connections'),message=el('p','Review a Health connection already approved on your server.'),sourceLabel=el('label','Prepared Health connection'),source=el('select'),detail=el('div');
 source.setAttribute('aria-label','Prepared Health connection');load.type='button';load.className='secondary';message.setAttribute('role','status');message.setAttribute('aria-live','polite');sourceLabel.append(source);sourceLabel.hidden=true;
 root.replaceChildren(el('h3','Set up Health on this phone'),el('p','Prepare an existing connection, then request Apple Health access and sync separately. This does not create server approval or change your existing data-use settings.'),load,message,sourceLabel,detail);
 let generation=0,catalog=null,loadedOwner=null,pendingJob=null,prepared=false,uncertain=false,updates=null;
 const live=()=>!!loadedOwner&&current(loadedOwner);
 function controls(){load.disabled=!!pendingJob;source.disabled=!!pendingJob;detail.querySelectorAll('button[data-operation]').forEach(button=>{button.disabled=!!pendingJob||uncertain||(button.dataset.operation!=='setup'&&!prepared)||typeof native[{setup:'healthSetupChoice',permission:'healthRequestReadPermission',sync:'healthSyncChoice'}[button.dataset.operation]]!=='function'});updates?.refreshAvailability()}
 function clear(){updates?.invalidate();updates=null;catalog=null;loadedOwner=null;prepared=false;uncertain=false;source.replaceChildren();sourceLabel.hidden=true;detail.replaceChildren()}
 function render(){
  generation++;updates?.invalidate();updates=null;prepared=false;uncertain=false;detail.replaceChildren();if(!catalog||!live()||source.value==='')return;
  const index=Number(source.value);if(!Number.isInteger(index)||index<0||index>=catalog.choices.length)return;const choice=catalog.choices[index];
  detail.append(el('p',choice.label),el('p',`Destination: ${choice.destinationLabel}`),el('p','Scope: your existing server-approved connection on this phone.'),el('p',`Configured data: ${choice.dataChoices.map(plan=>plan.label).join(', ')}`),el('p','This can help provide context for sleep and related measurements, when readable data and your existing use settings allow it.'),el('p','Effective use and Assistant access are not checked here. Your existing settings are unchanged. Apple Health read access and history coverage remain unknown.'));
  const categoryLabel=el('label','Data to sync'),category=el('select');category.setAttribute('aria-label','Data to sync');category.append(new Option('Choose configured data',''));choice.dataChoices.forEach((plan,i)=>category.append(new Option(plan.label,String(i))));categoryLabel.append(category);
  prepared=choice.localSetup==='configuredLocalConfirmed';const setup=el('button',choice.localSetup==='configuredLocalConfirmed'?'Confirm current local setup':choice.localSetup==='confirmSavedLocal'?'Reconnect saved setup':choice.localSetup==='prepareNewLocal'?'Set up on this phone':'Prepare on this phone'),permission=el('button','Request Apple Health access'),sync=el('button','Sync now'),note=el('p');note.setAttribute('role','status');note.setAttribute('aria-live','polite');
  for(const [kind,button] of [['setup',setup],['permission',permission],['sync',sync]]){button.type='button';button.className='secondary';button.dataset.operation=kind;button.addEventListener('click',event=>act(kind,event,choice,category,note))}
  detail.append(setup,permission,categoryLabel,sync,note);
  if(typeof native.healthObservationChoice==='function'){
   const updatesRoot=el('section'),selectedGeneration=generation,selectedCatalog=catalog;detail.append(updatesRoot);
   updates=createHealthObservationView({root:updatesRoot,native,owner:()=>loadedOwner,current:id=>live()&&id===loadedOwner&&generation===selectedGeneration&&catalog===selectedCatalog,binding:()=>({catalogId:selectedCatalog.catalogId,choice:choice.choice}),enabled:()=>prepared&&!pendingJob&&!uncertain});
  }
  controls();
 }
 function act(kind,event,choice,category,note){
  if(!event.isTrusted||pendingJob||uncertain||!catalog||!live()||catalog.choices[Number(source.value)]!==choice||(kind!=='setup'&&!prepared))return;
  const method={setup:'healthSetupChoice',permission:'healthRequestReadPermission',sync:'healthSyncChoice'}[kind];if(typeof native[method]!=='function')return;
  const request={catalogId:catalog.catalogId,choice:choice.choice};
  if(kind==='sync'){const index=Number(category.value);if(category.value===''||!Number.isInteger(index)||!choice.dataChoices[index]){note.textContent='Choose configured data to sync.';return}request.categoryChoice=choice.dataChoices[index].categoryChoice}
  const job={generation,owner:loadedOwner,catalog,choice};pendingJob=job;controls();note.textContent={setup:'Preparing local setup…',permission:'Requesting Apple Health access…',sync:'Syncing configured data…'}[kind];
  const still=()=>job.generation===generation&&job.owner===loadedOwner&&job.catalog===catalog&&live()&&catalog.choices[Number(source.value)]===choice;
  Promise.resolve().then(()=>still()?native[method](request):null).then(value=>{
   if(!still())return;
   if(!setupReply(value,kind,request)){uncertain=true;note.textContent='The result could not be confirmed. No new setup, access or sync state is confirmed.';return}
   if(kind==='setup'){
    if(value.setupOutcome==='prepared'){prepared=true;note.textContent='Local setup is prepared. Apple Health read access is still unknown. Request access or sync only with a separate action.'}
    else if(value.setupOutcome==='notConfirmed'){uncertain=true;note.textContent='Local setup is not confirmed. No permission request or sync was started by this action.'}
    else note.textContent='Local setup did not start. This connection is currently unavailable.';
   }else if(kind==='permission'){
    note.textContent=value.requestState==='completedReadNotObservable'?'The Apple Health request completed. Apple does not report whether read access was granted. No data was synced.':value.requestState==='unsupported'?'Apple Health access requests are not supported by this configured connection.':value.requestState==='notInvoked'?'The access request did not start. Check the connection and local setup.':'The access request is not confirmed. Read access remains unknown; no data was synced.';
   }else{
    note.textContent={idle:'There are no pending changes to send. Readable data and history coverage remain unknown.',applied:'Changes were acknowledged. This does not establish complete history or a successful answer.',retry:'Sync needs a retry. Pending changes remain governed by the existing connection.',needsAttention:'Some changes need attention.',invalidReceipt:'The server receipt could not be confirmed.',deferred:'Sync was deferred. Existing settings remain unchanged.'}[value.syncOutcome]??'Sync could not be confirmed. Existing settings remain unchanged.';
   }
  }).catch(()=>{if(still()){uncertain=true;note.textContent='The result is unavailable. Existing work may still be held; no new state is confirmed.'}}).finally(()=>{if(pendingJob===job){pendingJob=null;controls()}});
 }
 source.addEventListener('change',render);
 load.addEventListener('click',event=>{
  if(!event.isTrusted||pendingJob)return;const identity=owner();generation++;clear();if(!identity){message.textContent='Sign in to review prepared connections.';return}
  loadedOwner=identity;const job={generation,owner:identity};pendingJob=job;controls();message.textContent='Loading prepared connections…';
  Promise.resolve().then(()=>current(identity)?native.healthSetupChoices({}):null).then(value=>{
   if(job.generation!==generation||loadedOwner!==identity||!current(identity))return;
   if(!setupCatalog(value)){message.textContent='Prepared connection details could not be confirmed.';return}
   if(value.state!=='available'){message.textContent=value.reason==='busy'?'Existing native work is still in progress.':'No prepared Health connection is available on this phone. Existing server settings are unchanged.';return}
   catalog=value;source.replaceChildren(new Option('Choose a prepared connection',''));value.choices.forEach((choice,i)=>source.append(new Option(choice.label,String(i))));sourceLabel.hidden=false;message.textContent='Choose a connection to review. Loading and selecting do not start setup, access requests or sync.';
  }).catch(()=>{if(job.generation===generation&&current(identity))message.textContent='Prepared connection details are unavailable.'}).finally(()=>{if(pendingJob===job){pendingJob=null;controls()}});
 });
 return {invalidate(){generation++;pendingJob=null;clear();controls();message.textContent='Review a Health connection already approved on your server.'}};
}

// Existing remote source only. This form composes native choices, never server
// enrollment, Apple Health permission, collection, consent or Assistant access.
function createExistingHealthPreparation({root,native,source,identity,live,onPrepared}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const labels={SleepSegment:'Sleep',heartRate:'Heart rate',restingHeartRate:'Resting heart rate',respiratoryRate:'Respiratory rate',hrvSDNN:'Heart rate variability (SDNN)'};
 const fields=el('fieldset'),legend=el('legend','Choose Health data for this phone'),checks=[];
 fields.append(legend);for(const category of Object.keys(labels).filter(value=>source.categories?.includes(value))){const label=el('label'),input=el('input');input.type='checkbox';input.value=category;input.setAttribute('aria-label',labels[category]);label.append(input,document.createTextNode(labels[category]));fields.append(label);checks.push(input)}
 const startLabel=el('label','Health range start'),start=el('input'),endLabel=el('label','Health range end'),end=el('input');
 start.type=end.type='datetime-local';start.step=end.step='1';start.setAttribute('aria-label','Health range start');end.setAttribute('aria-label','Health range end');startLabel.append(start);endLabel.append(end);
 const modeLabel=el('label','Local Health action'),mode=el('select');mode.setAttribute('aria-label','Local Health action');mode.append(new Option('Choose an action',''),new Option('Set up on this phone','prepareNewLocal'),new Option('Reconnect saved setup','confirmSavedLocal'));modeLabel.append(mode);
 const prepare=el('button','Prepare selected Health connection'),note=el('p');prepare.type='button';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
 root.append(el('h3','Prepare this existing Health source'),el('p','Choose data and dates explicitly. Times use this phone’s time zone. Each sync window is limited to 31 days; this does not set data retention.'),fields,startLabel,endLabel,modeLabel,prepare,note);
 if(source.categories?.includes('hrvRMSSD'))root.append(el('p','RMSSD is not supported by this Apple Health connector. It is not replaced with SDNN.'));
 let generation=0,pending=false,uncertain=false,installed=false;
 const inputs=[...checks,start,end,mode];
 function draft(){const categories=checks.filter(input=>input.checked).map(input=>input.value),a=new Date(start.value),b=new Date(end.value);return categories.length>0&&mode.value&&start.value&&end.value&&Number.isFinite(a.valueOf())&&Number.isFinite(b.valueOf())&&b>a&&b-a<=31*86400000?{categories,rangeStart:a.toISOString(),rangeEnd:b.toISOString(),localSetup:mode.value}:null}
 function controls(){prepare.disabled=pending||uncertain||installed||!live()||!draft();for(const input of inputs)input.disabled=pending||uncertain||installed}
 for(const input of inputs)for(const event of ['input','change'])input.addEventListener(event,()=>{generation++;note.textContent='';controls()});controls();
 prepare.addEventListener('click',async event=>{
  const chosen=draft();if(!event.isTrusted||pending||uncertain||installed||!live()||!chosen)return;
  const ticket=++generation;pending=true;controls();note.textContent='Preparing these local choices…';
  try{
   const value=await native.healthPrepareExistingSource({schemaVersion:'1.0.0',sourceNamespace:source.sourceNamespace,enrollmentId:source.currentEnrollmentId,endpointId:identity.endpointId,policyRevision:source.policyRevision,contextRevision:identity.revision,...chosen});
   if(ticket!==generation||!live())return;
   if(keys(value,['schemaVersion','state','reason','readKnowledge','localSetup'])&&value.schemaVersion==='1.0.0'&&value.state==='prepared'&&value.reason==='explicit_local_action_required'&&value.readKnowledge==='unknown'&&value.localSetup===chosen.localSetup){installed=true;onPrepared();note.textContent='These choices are prepared. Load prepared connections below, then choose Set up on this phone or Reconnect saved setup. Apple Health access and Sync now remain separate actions.'}
   else if(keys(value,['schemaVersion','state','reason','readKnowledge'])&&value.schemaVersion==='1.0.0'&&value.state==='unavailable'&&value.readKnowledge==='unknown'&&['invalid_input','invalid_range','health_resources_unavailable','source_unavailable','policy_unavailable','context_changed','original_owner_unavailable'].includes(value.reason)){uncertain=true;note.textContent='This setup is unavailable. An existing connection or an earlier change must be checked before continuing. No Apple Health access request or sync was started.'}
   else{uncertain=true;note.textContent='The result could not be confirmed. No new setup, access or sync state is confirmed.'}
  }catch{if(ticket===generation&&live()){uncertain=true;note.textContent='The result is unavailable. An earlier change may still be awaiting confirmation.'}}
  finally{pending=false;if(ticket===generation&&live())controls()}
 });
}

// In-process observation is an explicit action on the original prepared choice.
export function createHealthObservationView({root,native,owner,current,binding,enabled=()=>true}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const review=el('button','Review update dates'),start=el('button','Start updates'),stop=el('button','Stop updates'),check=el('input'),label=el('label','Keep these existing dates up to date'),scope=el('p'),note=el('p','Updates have not been requested.');check.type='checkbox';label.prepend(check);note.setAttribute('role','status');
 for(const b of[review,start,stop])b.type='button';root.append(el('h4','Updates while this connection is open'),el('p',typeof native.healthRememberedChoice==='function'?'Use only the existing collection dates. Remember this choice separately to recover it when reopening in the foreground. Apple Health read access remains unknown.':'Use only the existing collection dates. Background collection and recovery after reopening are not enabled. Apple Health read access remains unknown.'),review,scope,label,start,stop,note);
 let epoch=0,pending=null,reviewed=null,reviewedPlans=null,state='inactive',invalid=false,saved=null;
 if(typeof native.healthRememberedChoice==='function'){const savedRoot=el('section');root.append(savedRoot);saved=createHealthRememberedView({root:savedRoot,native,owner,current,binding,review:()=>reviewed===JSON.stringify(binding())?reviewedPlans:null,enabled:()=>!invalid&&enabled()&&!pending})}
 function controls(){saved?.refreshAvailability();const available=!invalid&&enabled();review.disabled=!available||!!pending;check.disabled=!available||!!pending||!reviewed;start.disabled=!available||!!pending||!reviewed||!check.checked||['armed','waiting','stopping','unsupported'].includes(state);stop.disabled=invalid||!reviewed||!['armed','waiting','stopping','deferred','unsupported'].includes(state)&&!pending}
 function valid(v,op,b){
  if(!keys(v,['schemaVersion','operation','state','reason','catalogId','choice','readKnowledge','plans'])||v.schemaVersion!=='1.0.0'||v.operation!==op||v.readKnowledge!=='unknown'||!['unavailable','inactive','waiting','stopping','armed','deferred','unsupported'].includes(v.state)||typeof v.reason!=='string'||v.reason.length>80||!Array.isArray(v.plans)||v.plans.length>5)return false;
  if(v.catalogId===null&&v.choice===null)return v.state==='unavailable'&&v.plans.length===0;
  return v.catalogId===b.catalogId&&v.choice===b.choice&&v.plans.length>0&&new Set(v.plans.map(p=>p.category)).size===v.plans.length&&v.plans.every(p=>keys(p,['category','rangeStart','rangeEnd'])&&['sleep','heartRate','restingHeartRate','respiratoryRate','hrvSDNN'].includes(p.category)&&typeof p.rangeStart==='string'&&typeof p.rangeEnd==='string'&&p.rangeStart.length===24&&p.rangeEnd.length===24&&Number.isFinite(Date.parse(p.rangeStart))&&Number.isFinite(Date.parse(p.rangeEnd))&&new Date(p.rangeStart).toISOString()===p.rangeStart&&new Date(p.rangeEnd).toISOString()===p.rangeEnd&&Date.parse(p.rangeEnd)>Date.parse(p.rangeStart)&&Date.parse(p.rangeEnd)-Date.parse(p.rangeStart)<=31*86400000);
 }
 function act(op,event){
  if(!event.isTrusted||invalid||(!enabled()&&op!=='stop')||(op!=='stop'&&pending)||(op==='start'&&(!reviewed||!check.checked)))return;
  const id=owner(),b=binding();if(!id||!current(id))return;
  if(op==='start'&&JSON.stringify(b)!==reviewed){reviewed=null;check.checked=false;controls();return}
  const ticket={epoch:++epoch,id,b};pending=ticket;if(op==='start')state='waiting';if(op==='stop')state='stopping';controls();
  const input={operation:op,...b};if(op==='start')input.humanConfirmed=true;
  Promise.resolve().then(()=>current(id)?native.healthObservationChoice(input):null).then(v=>{
   if(ticket.epoch!==epoch||invalid||!current(id)||JSON.stringify(binding())!==JSON.stringify(b))return;
   if(!valid(v,op,b)||(op==='start'&&JSON.stringify(v.plans)!==reviewedPlans)){reviewed=null;state='unavailable';note.textContent='Updates could not be confirmed. No new readiness or access is confirmed.';return}
   state=v.state;check.checked=false;
   if(v.plans.length){reviewed=JSON.stringify(b);reviewedPlans=JSON.stringify(v.plans);scope.textContent=v.plans.map(p=>`${p.category}: ${p.rangeStart} to ${p.rangeEnd}`).join('; ')}else{reviewed=null;scope.textContent=''}
   note.textContent={inactive:'Updates are off. Review the existing dates and confirm before starting.',armed:'Updates are registered for these dates while this connection remains open. Read access and coverage remain unknown.',waiting:'Updates are waiting for original work. A completed notification does not establish a saved sample.',stopping:'Updates are stopping. Original work may still be held.',deferred:'Updates are deferred. Existing dates and queued data remain governed by the connection.',unsupported:'Updates are unavailable from this configured client.',unavailable:'This connection is unavailable for updates. A withdrawn connection cannot resume here.'}[state];
  }).catch(()=>{if(ticket.epoch===epoch&&!invalid&&current(id)){state='deferred';note.textContent='The update result is unknown. Stop updates remains available; no new state is confirmed.'}}).finally(()=>{if(pending===ticket){pending=null;controls()}});
 }
 review.addEventListener('click',e=>act('status',e));start.addEventListener('click',e=>act('start',e));stop.addEventListener('click',e=>act('stop',e));check.addEventListener('change',controls);controls();
 return {refreshAvailability:controls,invalidate(){saved?.invalidate();invalid=true;epoch++;reviewed=null;pending=null;check.checked=false;scope.textContent='';note.textContent='Connection changed. Review it again.';controls()}};
}

// Durable preference is separate from this session's Start and from OS access.
export function createHealthRememberedView({root,native,owner,current,binding,review,enabled=()=>true}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const confirm=el('input'),label=el('label','Remember these reviewed dates and keep updates enabled'),save=el('button','Remember update choice'),stop=el('button','Stop remembered updates'),status=el('button','Check remembered choice'),note=el('p','This update choice has not been remembered.');
 confirm.type='checkbox';label.prepend(confirm);for(const b of[save,stop,status])b.type='button';note.setAttribute('role','status');
 root.append(el('h4','Remember on this phone'),el('p',typeof native.healthBackgroundChoice==='function'?'This choice covers active or reopened foreground recovery only. Background updates have a separate control below. Current account and settings are rechecked; Apple Health read access remains unknown.':'Recovery uses these exact dates when this app is active or reopened. Background collection is off. Recovery checks your current account and settings; it does not grant Apple Health access.'),label,save,stop,status,note);
 let generation=0,pending=null,invalid=false,known=false;
 function controls(){const live=!invalid&&enabled()&&!!review();confirm.disabled=!live||!!pending;save.disabled=!live||!!pending||!confirm.checked;status.disabled=invalid||!!pending||!known;stop.disabled=invalid||!known&&!pending}
 function act(operation,event){
  if(!event.isTrusted||invalid||(operation!=='stop'&&pending)||(operation==='remember'&&(!enabled()||!review()||!confirm.checked)))return;
  const identity=owner(),target=binding(),plans=review();if(!identity||!current(identity))return;
  const job={generation:++generation,identity,target};pending=job;known=true;confirm.checked=false;controls();note.textContent=operation==='stop'?'Stopping updates; saved preference is pending…':operation==='remember'?'Saving update choice…':'Checking saved preference…';
  const input={operation,...target};if(operation==='remember'){input.humanConfirmed=true;input.updatesEnabled=true}
  const live=()=>!invalid&&job.generation===generation&&current(identity)&&JSON.stringify(binding())===JSON.stringify(target);
  Promise.resolve().then(()=>live()?native.healthRememberedChoice(input):null).then(value=>{
   if(!live())return;
   const fields=['schemaVersion','operation','state','reason','catalogId','choice','readKnowledge','plans','persistence','updatesEnabled','recoveryScope'];
   if(!keys(value,fields)||value.schemaVersion!=='1.0.0'||value.operation!==operation||value.catalogId!==target.catalogId||value.choice!==target.choice||value.readKnowledge!=='unknown'||value.recoveryScope!=='nativeForegroundAndRelaunch'||!['pending','unconfirmed','notLoaded','requiresRebind','savedEnabled','savedDisabled'].includes(value.persistence)||!Array.isArray(value.plans)||(plans&&JSON.stringify(value.plans)!==plans)||!['boolean','object'].includes(typeof value.updatesEnabled)||(value.updatesEnabled!==null&&typeof value.updatesEnabled!=='boolean')){note.textContent='The saved preference could not be confirmed. Stop remains available.';return}
   note.textContent={pending:'The preference is pending. Original work may still be stopping.',unconfirmed:'Updates are held. The saved preference is unconfirmed.',requiresRebind:'The account changed. Review and reconnect this source before enabling updates.',savedEnabled:'Choice remembered. Foreground recovery will recheck this exact connection and dates. Read access remains unknown.',savedDisabled:'Updates are off and that preference is saved. Separate manual sync remains available.',notLoaded:'No saved update choice is confirmed.'}[value.persistence];
  }).catch(()=>{if(live())note.textContent='The result is unknown. Stop remains available; no saved state is confirmed.'}).finally(()=>{if(pending===job){pending=null;controls()}});
 }
 save.addEventListener('click',e=>act('remember',e));stop.addEventListener('click',e=>act('stop',e));status.addEventListener('click',e=>act('status',e));confirm.addEventListener('change',controls);controls();
 return{refreshAvailability:controls,invalidate(){invalid=true;generation++;pending=null;confirm.checked=false;note.textContent='Connection changed. Review the choice again.';controls()}};
}
export function createHealthSavedRecoveryView({root,native,owner,current}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const load=el('button','Check saved Health choice'),choices=el('select'),restore=el('button','Restore for manual sync'),stop=el('button','Stop saved Health updates'),note=el('p','Saved choices are checked when the app is active.');
 load.type=restore.type=stop.type='button';choices.setAttribute('aria-label','Saved Health choice');note.setAttribute('role','status');root.append(el('h3','Saved Health setup'),load,choices,restore,stop,note);
 let epoch=0,pending=false,rows=[],invalid=false,lastPersistence="notLoaded",background=null;
 function selected(){return choices.value===''?null:rows[Number(choices.value)]}
 function controls(){const row=selected();load.disabled=pending||invalid;choices.disabled=pending||invalid;restore.disabled=pending||invalid||!row||row.requiresRebind;stop.disabled=invalid||!row||row.requiresRebind||!row.updatesEnabled&&!pending&&!["pending","unconfirmed"].includes(lastPersistence);background?.refreshAvailability()}
 function valid(value){return keys(value,['schemaVersion','state','reason','choices','continuity','persistence','drain'])&&value.schemaVersion==='1.0.0'&&typeof value.state==='string'&&value.state.length<=80&&value.reason==='saved_selection_only'&&value.continuity==='boundedForegroundRecovery'&&['pending','unconfirmed','notLoaded','requiresRebind','savedEnabled','savedDisabled'].includes(value.persistence)&&['pending','drained'].includes(value.drain)&&Array.isArray(value.choices)&&value.choices.length<=32&&value.choices.every(x=>keys(x,['choice','updatesEnabled','requiresRebind','selectedCount'])&&uuid(x.choice)&&typeof x.updatesEnabled==='boolean'&&typeof x.requiresRebind==='boolean'&&integer(x.selectedCount,1)&&x.selectedCount<=5)}
 async function act(operation,event){
  if(!event.isTrusted||invalid||pending&&operation!=='stop')return;const id=owner();if(!id||!current(id))return;const row=selected();if(operation!=='status'&&(!row||row.requiresRebind))return;
  const ticket=++epoch,selectedToken=row?.choice;pending=true;controls();note.textContent=operation==='stop'?'Stopping updates; the saved preference is pending…':'Checking this saved setup…';
  try{const value=await native.healthSavedRecoveryChoice(operation==='status'?{operation}:{operation,choice:row.choice});if(ticket!==epoch||!current(id))return;
   if(!valid(value)){note.textContent=operation==='stop'?'The Stop result is unconfirmed. Original work may still be held.':'Saved setup could not be confirmed.';return}
   lastPersistence=value.persistence;rows=value.choices;choices.replaceChildren(new Option('Choose saved setup',''));rows.forEach((r,i)=>choices.append(new Option(r.requiresRebind?'Reconnect required':r.updatesEnabled?'Updates enabled':'Updates off',String(i))));const index=rows.findIndex(x=>x.choice===selectedToken);if(index>=0)choices.value=String(index);
   if(value.persistence==='unconfirmed')note.textContent='Updates are held. The saved Stop preference is unconfirmed; original work may still be stopping.';
   else if(value.persistence==='pending')note.textContent='Updates are stopping. The saved preference is still pending.';
   else if(value.persistence==='savedDisabled'&&operation==='stop')note.textContent=value.drain==='pending'?'Updates are off and that preference is saved. Original work is still stopping.':'Updates are off and that preference is saved. Separate manual sync remains available.';
   else note.textContent={restoredEnabled:'Saved setup restored with updates enabled. Read access remains unknown.',restoredManual:'Saved setup restored for separate manual sync. Updates remain off.',disabled:'Updates are off. You can restore the saved setup for a separate manual sync.',absent:'No saved Health setup is available.',requiresRebind:'The account changed. Review and reconnect the source.',pending:'Recovery is waiting for original work.',authenticationRequired:'Sign in to recover this setup.',storageUnconfirmed:'Saved state is unconfirmed. Updates remain held.'}[value.state]??'Recovery checks the current account and settings. Original work may still be held.';
  }catch{if(ticket===epoch&&current(id))note.textContent=operation==='stop'?'The Stop result is unknown. No saved or drained state is confirmed.':'Recovery status is unavailable. No new state is confirmed.'}
  finally{if(ticket===epoch){pending=false;controls()}}
 }
 load.addEventListener('click',e=>act('status',e));restore.addEventListener('click',e=>act('restore',e));stop.addEventListener('click',e=>act('stop',e));choices.addEventListener('change',controls);if(typeof native.healthBackgroundChoice==='function'){const panel=el('section');root.append(panel);background=createHealthBackgroundView({root:panel,native,owner,current,choice:()=>selected()?.choice??null,enabled:()=>!invalid&&!selected()?.requiresRebind})}controls();return{invalidate(){background?.invalidate();epoch++;invalid=true;pending=false;rows=[];choices.replaceChildren();note.textContent='Session changed. Reopen this view.';controls()}};
}


// Deliberate background scope. Foreground remember does not select this scope.
export function createHealthBackgroundView({root,native,owner,current,choice,enabled=()=>true}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const review=el('button','Review background updates'),check=el('input'),label=el('label','Allow background updates for these exact dates'),save=el('button','Enable background updates'),off=el('button','Turn background updates off'),status=el('button','Check background updates'),dates=el('p'),note=el('p','Background updates have not been selected.');
 check.type='checkbox';label.prepend(check);for(const b of[review,save,off,status])b.type='button';note.setAttribute('role','status');
 root.append(el('h4','Background updates'),el('p','Choose this separately. Only the reviewed collection dates and existing permissions apply. iOS decides eligible opportunities; timing varies. Apple Health read access remains unknown.'),review,dates,label,save,off,status,note);
 let epoch=0,pending=false,invalid=false,reviewed=null,lastChoice=null;
 function controls(){const live=!invalid&&enabled()&&uuid(choice());review.disabled=!live||pending;save.disabled=!live||pending||!reviewed||!check.checked;check.disabled=!live||pending||!reviewed;off.disabled=!live;status.disabled=!live||pending}
 function refreshAvailability(){const next=choice();if(next!==lastChoice){lastChoice=next;epoch++;pending=false;reviewed=null;check.checked=false;dates.textContent='';note.textContent='Review this saved choice before enabling background updates.'}controls()}
 function valid(v){return keys(v,['schemaVersion','state','readKnowledge','persistence','registration','drain','review','plans','destination'])&&v.schemaVersion==='1.0.0'&&typeof v.state==='string'&&v.readKnowledge==='unknown'&&['unselected','enabled','disabled','pending','unconfirmed'].includes(v.persistence)&&['notRequested','pendingEnable','pendingDisable','registered','disabled','unknown'].includes(v.registration)&&['pending','drained'].includes(v.drain)&&(v.review===null||uuid(v.review))&&Array.isArray(v.plans)&&v.plans.length<=5&&v.plans.every(p=>keys(p,['category','rangeStart','rangeEnd'])&&['sleep','heartRate','restingHeartRate','respiratoryRate','hrvSDNN'].includes(p.category)&&Number.isFinite(p.rangeStart)&&Number.isFinite(p.rangeEnd)&&p.rangeEnd>p.rangeStart&&p.rangeEnd-p.rangeStart<=31*86400)&&(v.destination===null||typeof v.destination==='string')}
 async function act(operation,event){
  if(!event.isTrusted||invalid||!enabled()||!uuid(choice())||(pending&&operation!=='off')||(operation==='enable'&&(!reviewed||!check.checked)))return;
  const who=owner(),target=choice();if(!who||!current(who))return;const ticket=++epoch,input={operation,choice:target};if(operation==='enable'){input.review=reviewed;input.humanConfirmed=true}
  pending=true;check.checked=false;if(operation!=='enable')reviewed=null;controls();note.textContent=operation==='off'?'Stopping background updates; the preference and OS result are pending…':'Checking background scope…';
  try{const value=await native.healthBackgroundChoice(input);if(ticket!==epoch||!current(who)||choice()!==target)return;
   if(!valid(value)){note.textContent='Background result is unconfirmed. Turning updates off remains available.';return}
   if(operation==='review'&&value.state==='reviewed'&&uuid(value.review)&&value.plans.length){reviewed=value.review;dates.textContent=value.plans.map(p=>p.category+': '+new Date(p.rangeStart*1000).toISOString()+' to '+new Date(p.rangeEnd*1000).toISOString()).join('; ')+' → '+value.destination;note.textContent='Review these exact dates, then choose the unchecked option to enable background updates.';return}
   reviewed=null;
   const preference={unselected:'No background choice is saved.',enabled:'The background choice is saved enabled.',disabled:'The background choice is saved off.',pending:'The background preference is pending.',unconfirmed:'The background preference is unconfirmed.'}[value.persistence];
   const registration={notRequested:'No OS registration is confirmed.',pendingEnable:'OS registration is pending.',pendingDisable:'OS deactivation is pending.',registered:'OS registration was confirmed; delivery timing is not guaranteed.',disabled:'OS deactivation was confirmed.',unknown:'The OS result is unknown; original work remains held.'}[value.registration];
   note.textContent=preference+' '+registration+(value.drain==='pending'?' Original callbacks or work remain held.':'')+' Foreground updates and manual sync have separate controls.';
  }catch{if(ticket===epoch&&current(who))note.textContent='Background result is unknown. No saved or OS outcome is confirmed; turning updates off remains available.'}
  finally{if(ticket===epoch){pending=false;controls()}}
 }
 review.addEventListener('click',e=>act('review',e));save.addEventListener('click',e=>act('enable',e));off.addEventListener('click',e=>act('off',e));status.addEventListener('click',e=>act('status',e));check.addEventListener('change',controls);refreshAvailability();
 return{refreshAvailability,invalidate(){epoch++;invalid=true;pending=false;reviewed=null;check.checked=false;dates.textContent='';note.textContent='Session changed. Reopen this view.';controls()}};
}
