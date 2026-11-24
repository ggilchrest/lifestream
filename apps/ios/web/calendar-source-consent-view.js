// Source decisions are separate from system permission, connection and Sync.
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const bounded=v=>{try{return isObject(v)&&new TextEncoder().encode(JSON.stringify(v)).length<=32768}catch{return false}};
const valid=v=>bounded(v)&&v.schemaVersion==='1.0.0'&&['unavailable','held','review','recorded','connectionReview','connected','saved','reconciled'].includes(v.state);
export function createCalendarSourceConsentView({root,native,owner,current,onBegin=()=>{}}){
 const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node};
 const button=(text,fn)=>{const b=el('button',text);b.type='button';b.addEventListener('click',fn);return b};
 const message=el('p','Review collection and transmission consent independently. These choices do not grant an Assistant access to Calendar data.');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 const detail=el('div'),actions=el('div'),purpose=el('select'),validity=el('select'),expiry=el('input'),deadline=el('input'),confirm=el('input');
 purpose.setAttribute('aria-label','Source consent purpose');purpose.append(new Option('Choose a purpose',''),new Option('Collection','collection'),new Option('Transmission','transmission'));
 validity.setAttribute('aria-label','Consent validity');validity.append(new Option('Choose validity',''),new Option('Until revoked','untilRevoked'),new Option('Expires at a specified time','expiresAt'));
 expiry.type=deadline.type='datetime-local';expiry.setAttribute('aria-label','Consent expiry');deadline.setAttribute('aria-label','Review deadline');confirm.type='checkbox';confirm.checked=false;
 const confirmation=el('label','I confirm the exact decision shown above.');confirmation.append(confirm);
 let identity=null,review=null,connection=null,job=null,generation=0,held=false;
 const load=button('Review source consent',()=>perform('calendarLoadSourceConsent',{},'load'));
 const recover=button('Recover original consent result',()=>perform('calendarRecoverSourceConsent',{},'recover'));
 const request=button('Prepare consent review',()=>{const end=new Date(deadline.value),until=new Date(expiry.value);if(!purpose.value||!validity.value||!Number.isFinite(end.getTime())||validity.value==='expiresAt'&&!Number.isFinite(until.getTime())){message.textContent='Choose purpose, validity and a review deadline.';return}perform('calendarRequestSourceConsent',{reviewId:review.reviewId,purpose:purpose.value,validity:validity.value==='untilRevoked'?{kind:'untilRevoked'}:{kind:'expiresAt',expiresAt:until.toISOString()},reviewDeadlineAt:end.toISOString()},'request')});
 const approve=button('Approve reviewed consent',()=>perform('calendarConfirmSourceConsent',{reviewId:review.reviewId,humanConfirmed:true},'confirm'));
 const revoke=button('Revoke selected consent',()=>perform('calendarRevokeSourceConsent',{reviewId:review.reviewId,purpose:purpose.value,humanConfirmed:true},'revoke'));
 const reviewConnection=button('Review connection',()=>perform('calendarReviewSourceConnection',{},'connectionReview'));
 const connect=button('Connect / Resume source',()=>perform('calendarConnectSource',{connectionId:connection.connectionId,humanConfirmed:true},'connect'));
 actions.append(purpose,validity,el('p','Expiry, if selected (your phone’s local time):'),expiry,el('p','Review deadline (your phone’s local time):'),deadline,request,confirmation,approve,revoke,connect);
 root.replaceChildren(el('h3','Calendar source consent'),message,load,recover,detail,actions,reviewConnection);
 function controls(){const busy=!!job;load.disabled=busy||held;recover.disabled=busy;reviewConnection.disabled=busy||held;purpose.disabled=validity.disabled=expiry.disabled=deadline.disabled=busy||held;confirm.disabled=busy||held;request.disabled=busy||held||!review||!!review.request;approve.disabled=busy||held||!review?.request||review.approvalAvailable!==true||!confirm.checked;revoke.disabled=busy||held||!review||!!review.request||!purpose.value||!confirm.checked;connect.disabled=busy||held||!connection||!confirm.checked}
 function render(){
  detail.replaceChildren();const s=review?.source??connection?.source;
  if(s){for(const [key,label]of [['principalId','Signed-in person'],['endpointId','Phone endpoint'],['sourceNamespace','Source'],['installationId','Installation'],['environmentId','Environment'],['destinationId','Destination']])detail.append(el('p',`${label}: ${String(s[key]??'Unavailable')}`));detail.append(el('p',`Server: ${review?.serverOrigin??connection?.serverOrigin}`),el('p','Data: Calendar events. Assistant recipient: none. Recorded consent remains subject to current source, classification and retention policy. Nothing is read or sent by these actions.'))}
  for(const status of review?.statuses??[])detail.append(el('p',`${status.purpose}: ${status.consentState}${status.validity?.kind==='expiresAt'?` until ${status.validity.expiresAt}`:status.validity?.kind==='untilRevoked'?' until revoked':''}`));
  if(review?.request){const r=review.request;detail.append(el('p',`Review only: ${r.scope?.purpose}. ${r.validity?.kind==='untilRevoked'?'Until revoked':`Expires ${r.validity?.expiresAt}`}. Review deadline: ${r.reviewDeadlineAt}.`),el('p','Preparing this request did not approve consent. Check the separate confirmation box to approve this exact review.'))}
  if(connection)detail.append(el('p',`Source state: ${connection.sourceState}; collection paused: ${connection.collectionPaused}. Connect / Resume changes the remote source connection only. Local availability is checked afterward; system access and Sync remain separate.`),el('p',`Saved range: ${JSON.stringify(connection.syncWindow)}`));controls();
 }
 async function perform(method,input,kind){
  if(job||held&&kind!=='recover'||['confirm','revoke','connect'].includes(kind)&&!confirm.checked)return;
  const captured=owner();if(!captured||!current(captured)){message.textContent='Sign in as yourself to review Calendar source consent.';return}
  if(identity&&!current(identity)){invalidate();return}
  if(typeof native[method]!=='function'){message.textContent='Source consent is unavailable in this app version.';return}
  onBegin();const token=++generation,run={};job=run;identity=captured;confirm.checked=false;controls();message.textContent='Checking the original source and current decision…';
  try{
   const value=await native[method](input);if(token!==generation||!current(captured))return;
   if(!valid(value)){held=true;review=connection=null;message.textContent='The result is unconfirmed. Recover the original result before another action.';return}
   if(value.state==='held'){held=true;review=connection=null;message.textContent='The original operation remains held. Recover its exact result; no replacement or automatic retry has started.'}
   else if(value.state==='review'){
    if(!uuid(value.reviewId)||!isObject(value.source)||!Array.isArray(value.statuses)||value.statuses.length!==2||value.statuses.some(s=>!['collection','transmission'].includes(s.purpose)||!['absent','valid','expired','revoked'].includes(s.consentState))){held=true;review=connection=null;message.textContent='Source review could not be confirmed.';return}
    held=false;review=value;connection=null;purpose.value='';validity.value='';expiry.value=deadline.value='';message.textContent=value.request?'Review the exact prepared request, then confirm separately.':'Choose one purpose, validity and review deadline. Nothing is preapproved.';
   }else if(value.state==='connectionReview'){
    if(!uuid(value.connectionId)||!isObject(value.source)||!isObject(value.syncWindow)){held=true;review=connection=null;return}
    held=false;connection=value;review=null;message.textContent='Review the saved source settings, then confirm Connect / Resume separately.';
   }else{held=false;review=connection=null;message.textContent=value.state==='recorded'?'The source decision was recorded. Connection, effective policy, system access and Sync remain separate.':value.state==='saved'&&value.activation==='manualOnly'?'Source connected and locally available. Choose Sync separately.':value.state==='connected'?(value.reason==='connected_policy_unavailable'?'Source connected, but current policy is denied or unavailable. Nothing was collected or sent.':'Source connected. Review your local Calendar selection before using it.'):'This action is unavailable or requires a fresh review. No further action has started.'}
  }catch{if(token===generation&&current(captured)){held=true;review=connection=null;message.textContent='The result is unconfirmed. Recover the original result.'}}
  finally{if(job===run){job=null;render()}}
 }
 const changed=()=>{confirm.checked=false;if(review?.request||connection){review=connection=null;message.textContent='The reviewed choices changed. Load a fresh review before deciding.';render()}else controls()};
 for(const node of [purpose,validity,expiry,deadline])node.addEventListener('change',changed);confirm.addEventListener('change',controls);
 function invalidate(){generation++;job=null;identity=review=connection=null;held=false;confirm.checked=false;purpose.value=validity.value='';expiry.value=deadline.value='';message.textContent='Review source consent explicitly for your current connection.';render()}
 controls();return {invalidate};
}
