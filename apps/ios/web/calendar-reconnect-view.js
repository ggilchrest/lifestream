import {createCalendarSourceConsentView} from './calendar-source-consent-view.js';
import {createCalendarSelectionView} from './calendar-selection-view.js';
import {createCalendarLocalSetupView} from './calendar-local-setup-view.js';
// Configured native hints only. Reconnect and pending-only delivery are separate explicit actions.
const keys=(v,w)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===w.length&&w.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const size=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const label=v=>typeof v==='string'&&v.length>0&&Array.from(v).length<=120&&new TextEncoder().encode(v).length<=512&&!/[\u0000-\u001f]/u.test(v);
function validCatalog(v){
 if(!keys(v,['schemaVersion','state','reason','catalogId','choices'])||v.schemaVersion!=='1.0.0'||!['ready','no_configuration','context_unavailable','context_changed','busy'].includes(v.reason)||!Array.isArray(v.choices)||size(v)>16384)return false;
 if(v.state==='unavailable')return v.reason!=='ready'&&v.catalogId===null&&v.choices.length===0;
 if(v.state!=='available'||v.reason!=='ready'||!uuid(v.catalogId)||v.choices.length<1||v.choices.length>8)return false;
 const handles=new Set([v.catalogId]);
 for(const c of v.choices){if(!keys(c,['choice','label','destinationLabel','dataLabel','scope','pendingDeliveryReady'])||!uuid(c.choice)||handles.has(c.choice)||!label(c.label)||!label(c.destinationLabel)||!['Calendar events','Reminders'].includes(c.dataLabel)||c.scope!=='existingSavedOnly'||c.pendingDeliveryReady!==false)return false;handles.add(c.choice)}
 return true;
}
function validReply(v,operation,request){
 if(!keys(v,['schemaVersion','operation','catalogId','choice','reason','result'])||v.schemaVersion!=='1.0.0'||v.operation!==operation||!['ready','unavailable','invalid_choice','context_changed','busy'].includes(v.reason)||size(v)>4096)return false;
 if(v.reason==='ready'){if(v.catalogId!==request.catalogId||v.choice!==request.choice)return false}
 else if(v.catalogId!==null||v.choice!==null)return false;
 const r=v.result;
 if(operation==='reviewCollection'){
  if(r?.state==='unavailable')return v.reason!=='ready'&&keys(r,['state']);
  const stamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
  return v.reason==='ready'&&keys(r,['state','scope','destinationLabel','dataLabel','coverageStart','coverageEnd','timeZone'])&&r.state==='configured'&&r.scope==='collectAndDeliver'&&label(r.destinationLabel)&&['Calendar events','Reminders'].includes(r.dataLabel)&&stamp(r.coverageStart)&&stamp(r.coverageEnd)&&Date.parse(r.coverageEnd)>Date.parse(r.coverageStart)&&Date.parse(r.coverageEnd)-Date.parse(r.coverageStart)<=31*86400000&&typeof r.timeZone==='string'&&r.timeZone.length>0&&new TextEncoder().encode(r.timeZone).length<=128&&!/[\u0000-\u001f]/u.test(r.timeZone);
 }
 if(operation==='collectAndDeliver'){
  const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=64;
  if(r?.state==='settledPrefix')return keys(r,['state','acquired','acceptedOrDuplicate','rejected','retryable','mayHaveMore'])&&['acquired','acceptedOrDuplicate','rejected','retryable'].every(k=>count(r[k]))&&r.acceptedOrDuplicate+r.rejected+r.retryable<=64&&typeof r.mayHaveMore==='boolean';
  if(r?.state==='emptyPending')return keys(r,['state','acquired'])&&count(r.acquired);
  if(r?.state==='retained')return keys(r,['state','reason'])&&['request_too_large','transport','receipt'].includes(r.reason);
  if(r?.state==='notApplied')return keys(r,['state','stage','reason'])&&['acquisition','delivery'].includes(r.stage)&&['unavailable','invalid','stale','cancelled','incomplete','truncated','busy','storage'].includes(r.reason);
  if(r?.state==='unconfirmed')return v.reason!=='ready'&&keys(r,['state','stage','attemptId'])&&['acquisition','settlement'].includes(r.stage)&&uuid(r.attemptId);
  return v.reason!=='ready'&&keys(r,['state'])&&r.state==='unavailable';
 }
 if(operation==='requestReadPermission'){
  if(!keys(r,['attemptId','requestState','readAccess'])||!['notInvoked','requestCompleted','deferred'].includes(r.requestState)||!['fullRead','denied','restricted','writeOnly','notDetermined','unknown'].includes(r.readAccess)||r.attemptId!==null&&!uuid(r.attemptId))return false;
  if(r.requestState!=='notInvoked'&&!uuid(r.attemptId))return false;
  if(r.requestState==='deferred')return v.reason!=='ready'&&r.readAccess==='unknown';
  return v.reason==='ready'||r.readAccess==='unknown';
 }
 if(operation==='reconnect'){
  if(!keys(r,['operation','attemptId','outcome','snapshotWrite','availability'])||r.operation!=='reconnect'||r.snapshotWrite!=='notRequested'||r.attemptId!==null&&!uuid(r.attemptId))return false;
  return v.reason==='ready'?r.outcome==='reconnected'&&r.availability==='available'&&uuid(r.attemptId):r.outcome==='notApplied'&&r.availability==='unavailable';
 }
 if(r?.state==='settledPrefix')return v.reason==='ready'&&keys(r,['state','acceptedOrDuplicate','rejected','retryable','mayHaveMore','acquired'])&&['acceptedOrDuplicate','rejected','retryable'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0&&r[k]<=64)&&r.acceptedOrDuplicate+r.rejected+r.retryable<=64&&typeof r.mayHaveMore==='boolean'&&r.acquired===null;
 if(r?.state==='emptyPending')return v.reason==='ready'&&keys(r,['state']);
 if(r?.state==='retained')return v.reason==='ready'&&keys(r,['state','reason'])&&['request_too_large','transport','receipt'].includes(r.reason);
 return v.reason!=='ready'&&keys(r,['state'])&&['unconfirmed','unavailable'].includes(r.state);
}
export function createCalendarReconnectView({root,native,owner,current}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const load=el('button','Load saved Calendar connections'),message=el('p','Review a connection already configured for this phone.'),labelNode=el('label','Saved Calendar connection'),select=el('select'),detail=el('div');
 load.type='button';load.className='secondary';select.setAttribute('aria-label','Saved Calendar connection');message.setAttribute('role','status');message.setAttribute('aria-live','polite');labelNode.append(select);labelNode.hidden=true;
 root.replaceChildren(el('p','Reconnect an existing saved connection, then deliver retained items separately. This does not collect new Calendar data or request system access.'),load,message,labelNode,detail);
 const localRoot=el('section');root.append(localRoot);
 const local=createCalendarLocalSetupView({root:localRoot,native,owner,current,onBegin:()=>{consent.invalidate();invalidateSaved()}});
 const pickerRoot=el('section');root.append(pickerRoot);const picker=createCalendarSelectionView({root:pickerRoot,native,owner,current,onBegin:()=>{consent.invalidate();local.invalidate();invalidateSaved()}});
 const consentRoot=el('section');root.append(consentRoot);const consent=createCalendarSourceConsentView({root:consentRoot,native,owner,current,onBegin:()=>{local.invalidate();picker.invalidate();invalidateSaved()}});
 let generation=0,selectionGeneration=0,catalog=null,identity=null,job=null,ready=false,uncertain=false,syncReview=null;
 const clear=()=>{selectionGeneration++;catalog=null;identity=null;ready=false;uncertain=false;syncReview=null;select.replaceChildren();labelNode.hidden=true;detail.replaceChildren()};
 const live=run=>run.generation===generation&&run.selection===selectionGeneration&&run.identity===identity&&run.catalog===catalog&&current(run.identity)&&select.value===run.index;
 function controls(){load.disabled=!!job||uncertain;select.disabled=!!job||uncertain;for(const button of detail.querySelectorAll('button'))button.disabled=!!job||uncertain||(button.dataset.operation==='reconnect'?ready:!ready)||(button.dataset.operation==='collectAndDeliver'&&!syncReview)||(['reconnect','deliverPending'].includes(button.dataset.operation)&&typeof native[button.dataset.operation==='reconnect'?'calendarReconnectChoice':'calendarDeliverPendingChoice']!=='function')}
 function render(){
  detail.replaceChildren();const c=catalog?.choices[Number(select.value)];if(select.value===''||!c){controls();return}
  detail.append(el('p',`Destination: ${c.destinationLabel}`),el('p',`Data: ${c.dataLabel}`),el('p','This configured option does not establish that its saved connection is currently available. Reconnect checks the original saved binding.'));
  detail.append(el('p','System permission is separate from your saved connection and source settings. Apple requests full access, which also permits changes. This Lifestream feature contains no event or reminder write operations. Requesting permission does not collect or send data.'));
  for(const [operation,text]of [['reconnect','Reconnect saved connection'],['deliverPending','Deliver retained pending items'],['requestReadPermission',c.dataLabel==='Reminders'?'Request Reminders reading':'Request Calendar reading'],['reviewCollection','Review collection and send details']]){const b=el('button',text);b.type='button';b.dataset.operation=operation;b.addEventListener('click',()=>perform(operation));detail.append(b)}
  if(syncReview){
   detail.append(el('p',`Collect and transmit to: ${syncReview.destinationLabel}`),el('p',`Data to collect: ${syncReview.dataLabel}`),el('p',`Configured scan interval (partial): ${syncReview.coverageStart} to ${syncReview.coverageEnd}. Captured time zone: ${syncReview.timeZone}.`),el('p',syncReview.dataLabel==='Reminders'?'Reminders are read from the configured lists; this scan interval is not a due-date filter. This is a bounded partial scan, not a complete sync.':'This reads the configured Calendar interval and sends the original retained queue prefix. This is a bounded partial scan, not a complete sync.'));
   const b=el('button','Sync now (collect and send)');b.type='button';b.dataset.operation='collectAndDeliver';b.addEventListener('click',()=>perform('collectAndDeliver'));detail.append(b);
  }controls();
 }
 async function perform(operation){
  if(job||uncertain||!catalog||!identity||!current(identity)||select.value==='')return;
  if(operation==='reconnect'&&ready||operation!=='reconnect'&&!ready||operation==='collectAndDeliver'&&!syncReview)return;
  const c=catalog.choices[Number(select.value)];if(!c)return;
  const method={reconnect:'calendarReconnectChoice',requestReadPermission:'calendarRequestReadPermissionChoice',reviewCollection:'calendarCollectionDetailsChoice',collectAndDeliver:'calendarCollectAndDeliverChoice',deliverPending:'calendarDeliverPendingChoice'}[operation];if(typeof native[method]!=='function'){if(operation==='requestReadPermission')message.textContent='System reading requests are unavailable in this app version.';else if(['reviewCollection','collectAndDeliver'].includes(operation))message.textContent='Manual collection and sending are unavailable in this app version.';return;}
  const run={generation,selection:selectionGeneration,identity,catalog,index:select.value};job=run;
  const request={schemaVersion:'1.0.0',catalogId:catalog.catalogId,choice:c.choice};if(operation==='collectAndDeliver'||operation==='reconnect')syncReview=null;controls();message.textContent=operation==='reconnect'?'Checking the saved connection…':operation==='requestReadPermission'?'Checking the existing connection before requesting system access…':operation==='reviewCollection'?'Reviewing the original collection and destination configuration…':operation==='collectAndDeliver'?'Collecting from the configured source and sending to the original destination…':'Delivering retained pending items…';
  try{
   const v=await native[method](request);if(!live(run)){if(job===run)ready=false;return;}
   if(!validReply(v,operation,request)){ready=false;uncertain=true;message.textContent='The result could not be confirmed. No further action has been started.';return}
   if(operation==='reconnect'){
    ready=v.reason==='ready';message.textContent=ready?'Saved connection reconnected. No data was collected or delivered.':'Saved connection could not be reconnected. Its existing settings are unchanged.';
   }else if(operation==='reviewCollection'){
    syncReview=null;
    if(v.reason==='ready'&&v.result.dataLabel===c.dataLabel&&v.result.destinationLabel===c.destinationLabel){syncReview=v.result;message.textContent='Review the fixed category, interval and destination, then explicitly choose to collect and send.'}
    else if(v.reason==='ready'){ready=false;uncertain=true;message.textContent='The collection details do not match this connection. No collection has been started.'}
    else message.textContent='Collection and sending are unavailable or busy. No collection request has been started.';
    render();
   }else if(operation==='collectAndDeliver'){
    syncReview=null;const r=v.result;
    if(r.state==='unconfirmed'){ready=false;uncertain=true;message.textContent=(r.stage==='acquisition'?'Collection commit':'Delivery settlement')+' is unconfirmed. The original attempt remains held; do not retry or assume no work occurred.'}
    else if(r.state==='settledPrefix')message.textContent=`Collection committed ${r.acquired} item(s). Delivery: ${r.acceptedOrDuplicate} accepted or already received, ${r.rejected} rejected, ${r.retryable} retained for retry.${r.mayHaveMore?' More may remain.':''} This is a partial result, not a complete sync.`;
    else if(r.state==='emptyPending')message.textContent=`Collection committed ${r.acquired} item(s); no retained items were available to send. This is a partial scan result.`;
    else if(r.state==='retained')message.textContent='Delivery is unconfirmed. Collection or transmission may have occurred; retained work remains held. No automatic retry was started.';
    else if(r.state==='notApplied')message.textContent=r.stage==='acquisition'?'Collection commit was not applied; no delivery result was confirmed. Reading may already have occurred.':'Collection or transmission may already have occurred; delivery completion was not confirmed. No automatic retry was started.';
    else message.textContent='Manual collection is unavailable. No collection request was started.';
    if(v.reason!=='ready'&&r.state!=='unavailable'){ready=false;if(r.state!=='unconfirmed')message.textContent+=' The original result does not establish availability for the current connection.'}
    render();
   }else if(operation==='requestReadPermission'){
    const r=v.result;
    if(r.requestState==='deferred'){ready=false;uncertain=true;message.textContent='The system request is deferred or no longer current. Its original callback remains owned; no further action has been started.'}
    else if(v.reason==='context_changed'||v.reason==='invalid_choice'){ready=false;message.textContent='This connection is no longer current. No reading access has been confirmed.'}
    else if(r.readAccess==='fullRead')message.textContent=(r.requestState==='requestCompleted'?'System request completed; full access was observed.':'Full system access was observed; no new request was made.')+' This is a system capability observation, not source approval or data coverage. Nothing was collected or delivered.';
    else if(r.readAccess==='denied')message.textContent='System reading access is denied. You can review permission in iPhone Settings. Nothing was collected or delivered.';
    else if(r.readAccess==='restricted')message.textContent='System reading access is restricted. Nothing was collected or delivered.';
    else if(r.readAccess==='writeOnly')message.textContent='System access is write-only; reading access was not confirmed. Nothing was collected or delivered.';
    else if(r.readAccess==='notDetermined')message.textContent='System reading access has not been decided. Nothing was collected or delivered.';
    else message.textContent=r.requestState==='requestCompleted'?'The system request completed, but reading access could not be confirmed. Nothing was collected or delivered.':'Reading access is unavailable or unknown. No system request was made; nothing was collected or delivered.';
    // Preserve ONLY the pre-existing hint. Native still owns original admission
    // and checks it on the next explicit operation; no permission reply grants it.
   }else{
    const r=v.result;
    if(r.state==='unconfirmed'){ready=false;uncertain=true;message.textContent='Delivery is unconfirmed. Retained work remains held; no further action has been started.'}
    else if(r.state==='unavailable'){ready=false;message.textContent='Retained delivery is unavailable. No new collection has been started.'}
    else if(r.state==='emptyPending')message.textContent='No retained Calendar items to deliver.';
    else if(r.state==='retained')message.textContent='Retained items are still queued. Delivery was not confirmed; retry only when ready.';
    else message.textContent=`Retained delivery: ${r.acceptedOrDuplicate} accepted or already received, ${r.rejected} rejected, ${r.retryable} retained for retry.${r.mayHaveMore?' More retained items may remain.':''}`;
   }
  }catch{if(live(run)){ready=false;uncertain=true;message.textContent='The result could not be confirmed. No further action has been started.'}}
  finally{if(job===run){if(!live(run))ready=false;job=null;controls()}}
 }
 select.addEventListener('change',()=>{selectionGeneration++;ready=false;syncReview=null;if(job||uncertain){controls();return}render()});
 load.addEventListener('click',async()=>{
  if(job||uncertain)return;consent.invalidate();local.invalidate();const token=++generation;clear();const captured=owner();if(!captured){message.textContent='Sign in to review your saved Calendar connection.';return}
  if(typeof native.calendarSavedChoices!=='function'){message.textContent='Saved Calendar connections are unavailable in this app version.';return}
  const run={load:true};job=run;controls();message.textContent='Loading configured Calendar options…';
  try{const v=await native.calendarSavedChoices({});if(token!==generation||!current(captured))return;if(!validCatalog(v)){message.textContent='Saved Calendar connection details could not be confirmed.';return}if(v.state!=='available'){message.textContent='A saved Calendar connection is not available on this phone.';return}catalog=v;identity=captured;select.append(new Option('Choose a saved connection',''));for(let i=0;i<v.choices.length;i++)select.append(new Option(v.choices[i].label,String(i)));labelNode.hidden=false;message.textContent='Choose a configured connection to check its saved binding.'}
  catch{if(token===generation&&current(captured))message.textContent='Saved Calendar connection details are unavailable.'}
  finally{if(job===run)job=null;if(token===generation)controls()}
 });
 function invalidateSaved(){generation++;job=null;clear();load.disabled=false;message.textContent='Review a connection already configured for this phone.'}
 function invalidate(){consent.invalidate();picker.invalidate();local.invalidate();invalidateSaved()}
 controls();return {invalidate};
}
