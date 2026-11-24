// Native configured hints only; first local setup never enrolls a remote source.
const keys=(v,w)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===w.length&&w.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const size=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const label=v=>typeof v==='string'&&v.length>0&&Array.from(v).length<=120&&new TextEncoder().encode(v).length<=512&&!/[\u0000-\u001f]/u.test(v);
function validCatalog(v){
 if(!keys(v,['schemaVersion','state','reason','catalogId','choices'])||v.schemaVersion!=='1.0.0'||!['ready','no_configuration','context_unavailable','context_changed','busy'].includes(v.reason)||!Array.isArray(v.choices)||size(v)>16384)return false;
 if(v.state==='unavailable')return v.reason!=='ready'&&v.catalogId===null&&v.choices.length===0;
 if(v.state!=='available'||v.reason!=='ready'||!uuid(v.catalogId)||v.choices.length<1||v.choices.length>8)return false;
 const handles=new Set([v.catalogId]);
 for(const c of v.choices){if(!keys(c,['choice','label','destinationLabel','dataLabel','scope'])||!uuid(c.choice)||handles.has(c.choice)||!label(c.label)||!label(c.destinationLabel)||!['Calendar events','Reminders'].includes(c.dataLabel)||c.scope!=='existingRemoteLocalSetupOnly')return false;handles.add(c.choice)}
 return true;
}
function validReply(v,request){
 if(!keys(v,['schemaVersion','operation','catalogId','choice','reason','result'])||v.schemaVersion!=='1.0.0'||v.operation!=='setupLocal'||!['ready','unavailable','invalid_choice','context_changed','busy'].includes(v.reason)||size(v)>4096)return false;
 if(v.reason==='ready'){if(v.catalogId!==request.catalogId||v.choice!==request.choice)return false}
 else if(v.catalogId!==null||v.choice!==null)return false;
 const r=v.result;
 if(!keys(r,['attemptId','persistence','availability'])||!['saved','unconfirmed','notApplied'].includes(r.persistence)||!['available','unavailable'].includes(r.availability)||r.attemptId!==null&&!uuid(r.attemptId))return false;
 if(r.persistence!=='notApplied'&&!uuid(r.attemptId))return false;
 return v.reason==='ready'?r.persistence==='saved'&&r.availability==='available':r.availability==='unavailable';
}
export function createCalendarLocalSetupView({root,native,owner,current,onBegin=()=>{}}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const load=el('button','Review approved Calendar connection'),message=el('p','Set up an already-approved connection on this phone.'),labelNode=el('label','Approved Calendar connection'),select=el('select'),detail=el('div');
 load.type='button';load.className='secondary';select.setAttribute('aria-label','Approved Calendar connection');message.setAttribute('role','status');message.setAttribute('aria-live','polite');labelNode.append(select);labelNode.hidden=true;
 root.replaceChildren(el('p','First local setup checks an existing remote approval. It does not create a remote enrollment, request system access, or collect Calendar data.'),load,message,labelNode,detail);
 let generation=0,selectionGeneration=0,catalog=null,identity=null,job=null,terminal=false;
 const clear=()=>{selectionGeneration++;catalog=null;identity=null;terminal=false;select.replaceChildren();labelNode.hidden=true;detail.replaceChildren()};
 const live=run=>run.generation===generation&&run.selection===selectionGeneration&&run.identity===identity&&run.catalog===catalog&&current(run.identity)&&select.value===run.index;
 function controls(){load.disabled=!!job||terminal;select.disabled=!!job||terminal;for(const b of detail.querySelectorAll('button'))b.disabled=!!job||terminal}
 function render(){
  detail.replaceChildren();const c=catalog?.choices[Number(select.value)];if(select.value===''||!c){controls();return}
  detail.append(el('p',`Destination: ${c.destinationLabel}`),el('p',`Data: ${c.dataLabel}`),el('p','This configured option is not proof of current remote approval or saved local setup. Setup checks the original approval before saving locally.'));
  const b=el('button','Set up on this phone');b.type='button';b.addEventListener('click',perform);detail.append(b);controls();
 }
 async function perform(){
  if(job||terminal||!catalog||!identity||!current(identity)||select.value==='')return;
  const c=catalog.choices[Number(select.value)];if(!c)return;
  if(typeof native.calendarSetupExistingChoice!=='function'){message.textContent='Local Calendar setup is unavailable in this app version.';return}
  const run={generation,selection:selectionGeneration,identity,catalog,index:select.value};job=run;onBegin();
  const request={schemaVersion:'1.0.0',catalogId:catalog.catalogId,choice:c.choice};controls();message.textContent='Checking the existing approval and saving local setup…';
  try{
   const v=await native.calendarSetupExistingChoice(request);if(!live(run))return;
   if(!validReply(v,request)){terminal=true;message.textContent='The setup result could not be confirmed. No further action has been started.';return}
   const r=v.result;terminal=r.persistence!=='notApplied';
   if(r.persistence==='saved')message.textContent=v.reason==='ready'?'Local setup saved. Reconnect the saved connection separately when ready. No data was collected or delivered.':'Local setup was saved, but this connection is now unavailable. No further action has been started.';
   else if(r.persistence==='unconfirmed')message.textContent='Local setup is unconfirmed. The original attempt remains held; no further action has been started.';
   else message.textContent='Local setup was not applied. Review the connection before trying again.';
  }catch{if(live(run)){terminal=true;message.textContent='The setup result could not be confirmed. No further action has been started.'}}
  finally{if(job===run){job=null;controls()}}
 }
 select.addEventListener('change',()=>{selectionGeneration++;if(job||terminal){controls();return}render()});
 load.addEventListener('click',async()=>{
  if(job||terminal)return;const token=++generation;clear();const captured=owner();if(!captured){message.textContent='Sign in to review your approved Calendar connection.';return}
  if(typeof native.calendarLocalSetupChoices!=='function'){message.textContent='Local Calendar setup is unavailable in this app version.';return}
  const run={load:true};job=run;onBegin();controls();message.textContent='Loading configured Calendar options…';
  try{const v=await native.calendarLocalSetupChoices({});if(token!==generation||!current(captured))return;if(!validCatalog(v)){message.textContent='Local Calendar setup details could not be confirmed.';return}if(v.state!=='available'){message.textContent='An approved Calendar connection is not available for local setup on this phone.';return}catalog=v;identity=captured;select.append(new Option('Choose an approved connection',''));for(let i=0;i<v.choices.length;i++)select.append(new Option(v.choices[i].label,String(i)));labelNode.hidden=false;message.textContent='Choose a configured connection to check its existing remote approval.'}
  catch{if(token===generation&&current(captured))message.textContent='Local Calendar setup details are unavailable.'}
  finally{if(job===run)job=null;if(token===generation)controls()}
 });
 function invalidate(){generation++;job=null;clear();load.disabled=false;message.textContent='Set up an already-approved connection on this phone.'}
 controls();return {invalidate};
}
