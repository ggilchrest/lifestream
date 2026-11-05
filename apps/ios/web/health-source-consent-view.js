// Human source decisions are separate from SDK access and Assistant grants.
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const categoryLabels={SleepSegment:'Sleep',heartRate:'Heart rate',restingHeartRate:'Resting heart rate',respiratoryRate:'Respiratory rate',hrvSDNN:'Heart rate variability (SDNN)',hrvRMSSD:'Heart rate variability (RMSSD)'};
const categories=new Set(['SleepSegment','heartRate','restingHeartRate','respiratoryRate','hrvSDNN','hrvRMSSD']);
export function createHealthSourceConsentView({root,native,owner,current,source}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const button=(text,fn)=>{const n=el('button',text);n.type='button';n.addEventListener('click',fn);return n};
 let generation=0,job=null,review=null,held=false,identity=null;
 const message=el('p','Choose a category to review collection and transmission consent separately. Assistant access and Health system access remain separate.');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 const category=el('select');category.setAttribute('aria-label','Health consent category');category.append(new Option('Choose a category',''));for(const c of source()?.categories??[])if(categories.has(c))category.append(new Option(categoryLabels[c],c));
 const purpose=el('select');purpose.setAttribute('aria-label','Health consent purpose');purpose.append(new Option('Choose a purpose',''),new Option('Collection','collection'),new Option('Transmission','transmission'));
 const validity=el('select');validity.setAttribute('aria-label','Health consent validity');validity.append(new Option('Choose validity',''),new Option('Until revoked','untilRevoked'),new Option('Expires at a specified time','expiresAt'));
 const expiry=el('input'),deadline=el('input'),confirm=el('input'),detail=el('div');expiry.type=deadline.type='datetime-local';expiry.setAttribute('aria-label','Health consent expiry');deadline.setAttribute('aria-label','Health consent review deadline');confirm.type='checkbox';confirm.checked=false;
 const confirmation=el('label','I confirm the exact Health source decision shown above.');confirmation.append(confirm);
 const load=button('Review Health source consent',()=>{const s=source();if(!s||!category.value)return;perform('healthLoadSourceConsent',{sourceNamespace:s.sourceNamespace,enrollmentId:s.currentEnrollmentId,category:category.value},'load')});
 const recover=button('Recover original Health consent result',()=>perform('healthRecoverSourceConsent',{},'recover'));
 const request=button('Prepare Health consent review',()=>{const end=new Date(deadline.value),until=new Date(expiry.value);if(!purpose.value||!validity.value||!Number.isFinite(end.getTime())||validity.value==='expiresAt'&&!Number.isFinite(until.getTime())){message.textContent='Choose purpose, validity and a review deadline.';return}perform('healthRequestSourceConsent',{reviewId:review.reviewId,purpose:purpose.value,validity:validity.value==='untilRevoked'?{kind:'untilRevoked'}:{kind:'expiresAt',expiresAt:until.toISOString()},reviewDeadlineAt:end.toISOString()},'request')});
 const approve=button('Approve exact Health consent',()=>perform('healthConfirmSourceConsent',{reviewId:review.reviewId,humanConfirmed:true},'confirm'));
 const revoke=button('Revoke selected Health consent',()=>perform('healthRevokeSourceConsent',{reviewId:review.reviewId,purpose:purpose.value,humanConfirmed:true},'revoke'));
 root.replaceChildren(el('h3','Health source consent'),message,category,load,recover,detail,purpose,validity,el('p','Expiry, if selected (your phone’s local time):'),expiry,el('p','Review deadline (your phone’s local time):'),deadline,request,confirmation,approve,revoke);
 function controls(){const busy=!!job;category.disabled=busy||held;load.disabled=busy||held||!category.value;recover.disabled=busy;purpose.disabled=validity.disabled=expiry.disabled=deadline.disabled=confirm.disabled=busy||held;request.disabled=busy||held||!review||!!review.request;approve.disabled=busy||held||!review?.request||review.approvalAvailable!==true||!confirm.checked;revoke.disabled=busy||held||!review||!!review.request||!purpose.value||!confirm.checked}
 function render(){detail.replaceChildren();if(review){detail.append(el('p',`Data: ${categoryLabels[review.source.category]}. Destination: ${review.source.destinationId}.`),el('p','Recorded consent alone does not enable collection, transmission, Assistant use, system access or Sync.'));for(const s of review.statuses)detail.append(el('p',`${s.purpose}: ${s.consentState}`));if(review.request){const r=review.request;detail.append(el('p',`Review only: ${r.scope.purpose}; ${r.validity.kind==='untilRevoked'?'until revoked':`expires ${r.validity.expiresAt}`}; review deadline ${r.reviewDeadlineAt}.`),el('p','Preparing this review did not approve consent. Confirm this exact decision separately.'))}}controls()}
 function valid(value){try{return value&&new TextEncoder().encode(JSON.stringify(value)).length<=32768&&value.schemaVersion==='1.0.0'&&['review','recorded','held','unavailable'].includes(value.state)}catch{return false}}
 function matches(value){const s=source(),d=value.source;return uuid(value.reviewId)&&d?.collector==='healthKit'&&d.category===category.value&&d.sourceNamespace===s?.sourceNamespace&&d.enrollmentId===s?.currentEnrollmentId&&typeof d.destinationId==='string'&&Array.isArray(value.statuses)&&value.statuses.length===2&&new Set(value.statuses.map(s=>s.purpose)).size===2&&value.statuses.every(s=>['collection','transmission'].includes(s.purpose)&&['absent','valid','expired','revoked'].includes(s.consentState))}
 async function perform(method,input,kind){
  if(job||held&&kind!=='recover'||['confirm','revoke'].includes(kind)&&!confirm.checked)return;
  const captured=owner();if(!captured||!current(captured)||identity&&!current(identity)){invalidate();message.textContent='Sign in as yourself to review Health source consent.';return}
  if(typeof native[method]!=='function'){message.textContent='Health source consent is unavailable in this app version.';return}
  const token=++generation,run={};job=run;identity=captured;confirm.checked=false;controls();message.textContent='Checking the original Health source and decision…';
  try{const value=await native[method](input);if(token!==generation||!current(captured))return;
   if(!valid(value)||value.state==='held'){held=true;review=null;message.textContent='The original result is unconfirmed. Recover it before another action; nothing has been retried or replaced.'}
   else if(value.state==='review'){
    if(!matches(value)){held=true;review=null;message.textContent='The source review could not be confirmed.';return}
    review=value;held=false;purpose.value=validity.value=expiry.value=deadline.value='';message.textContent=value.request?'Review this exact request, then confirm separately.':'Choose one purpose, validity and review deadline. Nothing is preapproved.';
   }else{held=false;review=null;message.textContent=value.state==='recorded'?'The original source decision was recorded. Health setup, effective access, system permission and Sync remain unavailable until separately established.':'This action is unavailable or needs a fresh review. No other action has started.'}
  }catch{if(token===generation&&current(captured)){held=true;review=null;message.textContent='The result is unconfirmed. Recover the original Health consent result.'}}
  finally{if(job===run){job=null;render()}}
 }
 const changed=()=>{confirm.checked=false;if(review?.request){review=null;message.textContent='Reviewed choices changed. Load a fresh review before deciding.';render()}else controls()};
 category.addEventListener('change',()=>{generation++;review=null;confirm.checked=false;message.textContent='Review the selected category explicitly.';render()});for(const n of [purpose,validity,expiry,deadline])n.addEventListener('change',changed);confirm.addEventListener('change',controls);
 function invalidate(){generation++;job=null;review=null;identity=null;held=false;confirm.checked=false;category.value=purpose.value=validity.value=expiry.value=deadline.value='';message.textContent='Review Health source consent for the current source.';render()}
 controls();return {invalidate};
}
