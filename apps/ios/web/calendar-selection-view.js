// Explicit phone-local selection and source-owned duration intent. No data grants.
const keys=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&new TextEncoder().encode(v).length<=1024&&!/[\u0000-\u001f]/u.test(v);
const number=(v,max)=>Number.isInteger(v)&&v>=1&&v<=max;
const size=v=>new TextEncoder().encode(JSON.stringify(v)).length;
function limits(v){return keys(v,['maxTotalDays','maxScans','maxSelectedCalendars','maxScanSeconds','maxObservationsPerScan','maxScanBytes','maxDeliveryBytes'])&&number(v.maxTotalDays,366)&&number(v.maxScans,8)&&number(v.maxSelectedCalendars,32)&&v.maxScanSeconds===31*86400&&v.maxObservationsPerScan===64&&v.maxScanBytes===262144&&v.maxDeliveryBytes===65536}
function syncWindow(v){return keys(v,['schemaVersion','lookBackDays','lookAheadDays','timeZone'])&&v.schemaVersion==='1.0.0'&&Number.isInteger(v.lookBackDays)&&v.lookBackDays>=0&&Number.isInteger(v.lookAheadDays)&&v.lookAheadDays>=0&&v.lookBackDays+v.lookAheadDays>=1&&v.lookBackDays+v.lookAheadDays<=366&&text(v.timeZone)&&v.timeZone.length<=128}
function catalog(v){
 if(!keys(v,['schemaVersion','state','reason','catalogId','choices','limits','syncWindow'])||v.schemaVersion!=='1.0.0'||v.state!=='available'||v.reason!=='metadata_only'||!uuid(v.catalogId)||!Array.isArray(v.choices)||v.choices.length>256||!limits(v.limits)||v.syncWindow!==null&&!syncWindow(v.syncWindow)||size(v)>262144)return false;
 const handles=new Set(),ids=new Set();
 return v.choices.every(r=>{if(!keys(r,['choice','selected','title','sourceTitle','sourceKind','sourceIdentity','calendarIdentity','delegatedAccount','ownership','sharing'])||!uuid(r.choice)||r.selected!==false||handles.has(r.choice)||ids.has(r.calendarIdentity)||!['title','sourceTitle','sourceKind','sourceIdentity','calendarIdentity'].every(k=>text(r[k]))||r.ownership!=='unknown'||r.sharing!=='unknown'||r.delegatedAccount!==null&&typeof r.delegatedAccount!=='boolean')return false;handles.add(r.choice);ids.add(r.calendarIdentity);return true});
}
export function createCalendarSelectionView({root,native,owner,current,onBegin=()=>{}}){
 const el=(tag,value)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;return n};
 const permission=el('button','Request Calendar reading access'),load=el('button','Choose calendars on this phone'),review=el('button','Review selection and range'),message=el('p','Choose calendars explicitly. System access, selection and syncing are separate actions.'),rows=el('fieldset'),settings=el('fieldset'),bounds=el('div');
 const save=el('button','Save Calendar selection'),recover=el('button','Recover pending save or load saved range');
 const back=el('input'),ahead=el('input'),zone=el('input');
 for(const [input,label]of [[back,'Look back (days)'],[ahead,'Look ahead (days)'],[zone,'Time zone (IANA identifier)']]){input.setAttribute('aria-label',label);const l=el('label',label);l.append(input);settings.append(l)}
 back.type=ahead.type='number';back.min=ahead.min='0';back.step=ahead.step='1';zone.type='text';zone.maxLength=128;
 rows.append(el('legend','Calendars'));settings.prepend(el('legend','Manual sync range'));message.setAttribute('role','status');message.setAttribute('aria-live','polite');for(const b of [permission,load,review,save,recover])b.type='button';
 root.replaceChildren(el('h4','Select calendars'),el('p','Apple Calendar full access also permits changes. This feature reads events only. Requesting access does not discover calendars, read events or send data. Shared ownership may need your confirmation.'),permission,load,message,rows,settings,review,bounds,el('p','Saving creates or reuses this phone’s Calendar connection and saves the reviewed selection and range. Existing collection pauses stay in place. No events are read or sent by saving. Syncing is a separate manual action.'),save,recover);
 let generation=0,revision=0,job=null,data=null,identity=null,uncertain=false,controlHeld=false,prepared=null;
 const inputs=()=>[...rows.querySelectorAll('input')];
 function controls(){save.disabled=!!job||uncertain||!prepared;recover.disabled=!!job||(uncertain&&!controlHeld);permission.disabled=load.disabled=!!job||uncertain;review.disabled=!!job||uncertain||!data||!inputs().some(n=>n.checked);for(const n of [...inputs(),back,ahead,zone])n.disabled=!!job||uncertain}
 function clear(){data=null;identity=null;prepared=null;rows.replaceChildren(el('legend','Calendars'));back.value=ahead.value=zone.value='';bounds.replaceChildren();revision++}
 const live=r=>r.generation===generation&&r.revision===revision&&current(r.owner);
 async function call(kind,request){
  if(job||uncertain&&!(kind==='recover'&&controlHeld))return;const captured=owner();if(!captured){message.textContent='Sign in to select calendars.';return}
  const method={permission:'calendarBootstrapReadPermission',load:'calendarDiscoverSelections',review:'calendarPrepareSelection',save:'calendarSaveSelection',recover:'calendarReconcileSelection'}[kind];let invoke;try{invoke=native[method]}catch{}
  if(typeof invoke!=='function'){message.textContent='Calendar selection is unavailable in this app version.';return}
  if(kind==='permission'||kind==='load'){clear();onBegin()}
  const r={generation,revision,owner:captured};job=r;controls();if(kind!=='save')bounds.replaceChildren();message.textContent=kind==='permission'?'Checking the current phone session before requesting Calendar access…':kind==='load'?'Loading Calendar names and source identities only…':kind==='review'?'Preparing the exact selected range…':kind==='save'?'Saving the reviewed range and phone selection…':'Reconciling the exact original save; no mutation is replayed…';
  try{
   const v=await invoke.call(native,request);if(!live(r))return;
   if(kind==='permission'){
    if(v?.schemaVersion!=='1.0.0'||!['observed','unavailable'].includes(v.state)||size(v)>4096)throw Error('invalid');
    if(v.state==='unavailable'&&v.requestState===undefined){message.textContent='Calendar access is unavailable. No discovery or sync was started.';return}
    if(!keys(v,['schemaVersion','state','reason','attemptId','requestState','readAccess'])||!['notInvoked','requestCompleted','deferred'].includes(v.requestState)||!['fullRead','denied','restricted','writeOnly','notDetermined','unknown'].includes(v.readAccess)||v.attemptId!==null&&!uuid(v.attemptId))throw Error('invalid');
    if(v.requestState==='deferred'){uncertain=true;message.textContent='The original system request is unconfirmed. No further action has started.'}
    else message.textContent=`System reading capability: ${v.readAccess}. Choose calendars separately; nothing was read or sent.`;
   }else if(kind==='load'){
    if(v?.state==='unavailable'&&v.schemaVersion==='1.0.0'&&size(v)<4096){message.textContent='Calendar metadata is unavailable. No event query or sync was started.';return}
    if(!catalog(v))throw Error('invalid');data=v;identity=captured;
    for(const row of v.choices){const checkbox=el('input');checkbox.type='checkbox';checkbox.value=row.choice;checkbox.checked=false;const label=el('label');label.append(checkbox,document.createTextNode(`${row.title} — ${row.sourceTitle} (${row.sourceKind}). Source: ${row.sourceIdentity}; calendar: ${row.calendarIdentity}. Ownership/shared owner: unknown; confirm before importing.${row.delegatedAccount===true?' Delegated account observed.':''}`));rows.append(label);checkbox.addEventListener('change',changed)}
    back.max=ahead.max=String(v.limits.maxTotalDays);if(v.syncWindow){back.value=String(v.syncWindow.lookBackDays);ahead.value=String(v.syncWindow.lookAheadDays);zone.value=v.syncWindow.timeZone;}
    message.textContent=`Nothing is selected. Limits: ${v.limits.maxSelectedCalendars} calendars, ${v.limits.maxTotalDays} total days, ${v.limits.maxScans} scans of at most 31 elapsed days; 64 observations and 256 KiB per scan, 64 KiB per delivery. No background sync is configured.`;
   }else if(kind==='review'){
    const stamp=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&new Date(s).toISOString()===s;
    if(v?.state==='unavailable'&&v.schemaVersion==='1.0.0'&&size(v)<4096){message.textContent='The selected range or configuration is unavailable. Settings were not saved.';return}
    if(!keys(v,['schemaVersion','state','reason','previewId','syncWindow','settingsState','anchor','windows','limits','selectedCount','coverage','activation'])||v.schemaVersion!=='1.0.0'||v.state!=='prepared'||v.reason!=='explicit_save_required'||!uuid(v.previewId)||!keys(v.syncWindow,['schemaVersion','lookBackDays','lookAheadDays','timeZone'])||!['schemaVersion','lookBackDays','lookAheadDays','timeZone'].every(k=>v.syncWindow[k]===request.syncWindow[k])||v.settingsState!=='requestedNotSaved'||v.activation!=='unavailable'||v.coverage!=='partialObservations'||!stamp(v.anchor)||!limits(v.limits)||!Array.isArray(v.windows)||v.windows.length<1||v.windows.length>v.limits.maxScans||v.selectedCount!==request.choices.length||size(v)>16384)throw Error('invalid');
    let end=null;for(const w of v.windows){if(!keys(w,['start','endExclusive'])||!stamp(w.start)||!stamp(w.endExclusive)||Date.parse(w.endExclusive)<=Date.parse(w.start)||Date.parse(w.endExclusive)-Date.parse(w.start)>31*86400000||end!==null&&end!==w.start)throw Error('invalid');bounds.append(el('p',`${w.start} to ${w.endExclusive} (end exclusive)`));end=w.endExclusive}
    prepared={id:v.previewId,settings:v.syncWindow};message.textContent='Requested settings reviewed, not saved. Save the selection separately. No events were read or sent. Repeated window observations are not a distinct-event count.';
   }else{
    if(v?.schemaVersion!=='1.0.0'||size(v)>16384||!['saved','reconciled','held','unavailable'].includes(v.state)||!text(v.reason))throw Error('invalid');
    if(v.state==='unavailable'){if(!keys(v,['schemaVersion','state','reason']))throw Error('invalid');message.textContent='The save could not be applied. Review the selection before trying again.';prepared=null;return}
    if(v.state==='held'){
     const allowed=['schemaVersion','state','reason','operationId','settingsState','syncWindow','activation'];if(Object.keys(v).some(k=>!allowed.includes(k))||v.operationId!==undefined&&v.operationId!==null&&!uuid(v.operationId)||v.syncWindow!==undefined&&!syncWindow(v.syncWindow)||v.activation!==undefined&&v.activation!=='unavailable'||v.settingsState!==undefined&&!['saved','unconfirmed'].includes(v.settingsState))throw Error('invalid');
     uncertain=true;controlHeld=true;message.textContent='The original save is held. Use recovery to check that exact operation; do not start another save or sync.';return;
    }
    if(kind==='save'){
     if(!keys(v,['schemaVersion','state','reason','settingsState','syncWindow','localPersistence','activation','coverage'])||v.state!=='saved'||v.settingsState!=='saved'||!syncWindow(v.syncWindow)||!prepared||!Object.keys(prepared.settings).every(k=>v.syncWindow[k]===prepared.settings[k])||!['notApplied','saved'].includes(v.localPersistence)||!['manualOnly','unavailable'].includes(v.activation)||v.activation==='manualOnly'&&v.localPersistence!=='saved'||v.coverage!=='partialObservations')throw Error('invalid');
     message.textContent=v.activation==='manualOnly'?'Calendar selection and range saved. No events were read or sent. Load saved connections and review each window before manual syncing.':'Range saved on the server; local collection is unavailable. Existing pauses and policy requirements remain in place.';
    }else{
     if(!keys(v,['schemaVersion','state','reason','settingsState','syncWindow','activation'])||v.state!=='reconciled'||!['saved','rejected'].includes(v.settingsState)||v.activation!=='unavailable'||v.syncWindow!==null&&!syncWindow(v.syncWindow))throw Error('invalid');
     uncertain=false;controlHeld=false;clear();if(v.syncWindow){back.value=String(v.syncWindow.lookBackDays);ahead.value=String(v.syncWindow.lookAheadDays);zone.value=v.syncWindow.timeZone;}message.textContent='The original operation is reconciled. Load calendars and review a new selection before the next action. Nothing was automatically read or synced.';
    }
    prepared=null;
   }
  }catch{if(live(r)){uncertain=true;controlHeld=kind==='save'||kind==='recover';message.textContent='The result could not be confirmed. No further action has started.'}}
  finally{if(job===r){job=null;controls()}}
 }
 function changed(){prepared=null;revision++;bounds.replaceChildren();controls()}
 for(const n of [back,ahead,zone])n.addEventListener('input',changed);
 save.addEventListener('click',()=>{if(prepared)call('save',{schemaVersion:'1.0.0',previewId:prepared.id})});recover.addEventListener('click',()=>call('recover',{}));
 permission.addEventListener('click',()=>call('permission',{}));load.addEventListener('click',()=>call('load',{}));review.addEventListener('click',()=>{
  if(!data||!current(identity)||job||uncertain)return;const choices=inputs().filter(n=>n.checked).map(n=>n.value),integer=s=>/^\d+$/.test(s)?Number(s):NaN,b=integer(back.value),a=integer(ahead.value);
  if(!choices.length||choices.length>data.limits.maxSelectedCalendars||!Number.isSafeInteger(b)||!Number.isSafeInteger(a)||b<0||a<0||b+a<1||b+a>data.limits.maxTotalDays||!text(zone.value)){message.textContent='Select calendars and enter whole-day bounds within the displayed limits and a time zone.';return}
  call('review',{schemaVersion:'1.0.0',catalogId:data.catalogId,choices,syncWindow:{schemaVersion:'1.0.0',lookBackDays:b,lookAheadDays:a,timeZone:zone.value}});
 });
 function invalidate(){generation++;clear();uncertain=false;controlHeld=false;message.textContent='Choose calendars explicitly. System access, selection and syncing are separate actions.';controls()}
 controls();return {invalidate};
}
