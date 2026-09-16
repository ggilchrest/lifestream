/* PWCE owns approval and effects. This view only submits exact host reviews. */
(() => {
 const S=window.lifestreamSecurity,{el,fields,table}=S,$=id=>document.getElementById(id);
 let generation=0,current=null,proposal=null,feedback=null;
 const panel=()=>$('cap-pwce-workflow'),recent=()=>$('cap-pwce-recent');
 const key=()=>`lifestream.pwce.actions.${window.lifestreamAuth.session?.sessionId}.${S.assistant()}`;
 const references=()=>{try{const rows=JSON.parse(sessionStorage.getItem(key())||'[]');return Array.isArray(rows)?rows.filter(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)).slice(0,10):[];}catch{return [];}};
 const remember=id=>{try{sessionStorage.setItem(key(),JSON.stringify([id,...references().filter(v=>v!==id)].slice(0,10)));}catch{/* The current view remains usable without browser storage. */}};
 const url=id=>`${S.base()}/tools/invocations/${encodeURIComponent(id)}`;
 const body=()=>({idempotencyKey:current.record.idempotencyKey,confirmationDigest:current.record.preparation.confirmationDigest});
 const note=text=>{if(feedback)feedback.textContent=text;};
 const run=fn=>async()=>{const ticket=generation,epoch=S.epoch();panel().inert=true;try{await fn(()=>ticket===generation&&epoch===S.epoch());}catch(error){if(ticket===generation&&epoch===S.epoch())note(error.message);}finally{if(ticket===generation)panel().inert=false;}};
 const button=(parent,text,fn)=>{const b=el('button',text,'secondary');b.type='button';b.onclick=run(fn);parent.append(b);return b;};
 const details=(parent,title,value)=>{const d=el('details');d.append(el('summary',title),fields(value,true));parent.append(d);};
 const start=title=>{panel().hidden=false;$('cap-pwce-entry').hidden=true;$('cap-status').hidden=true;panel().replaceChildren();button(panel(),'Back to action form',()=>{if(proposal)throw new Error('Resolve this preparation with Retry same preparation first.');clear();renderRecent();$('cap-select').focus();});const h=el('h3',title);h.tabIndex=-1;feedback=el('p');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');panel().append(h,feedback);h.focus();return panel();};
 const exact=(parent,record)=>{const input=record.input;parent.append(fields({'Site':input.siteRef,'Target':input.targetEntityId,'Brightness (0–1)':input.parameters.level,'Invocation ID':record.preparation.invocationId,'Review expires':record.preparation.expiresAt},true));details(parent,'Original identifiers and proof',{'Preparation key':record.idempotencyKey,'Review digest':record.preparation.confirmationDigest,'Original authority':record.preparation.originalPreview,'Current authority':record.preparation.currentPreview});};
 const confirmed=(parent,label,fn,expires)=>{
  const field=el('label',undefined,'security-confirm'),check=el('input');check.type='checkbox';field.append(check,el('span','I reviewed the exact target, brightness, authority and expiry shown above.'));parent.append(field);
  const b=button(parent,label,async valid=>{if(!check.checked||Date.now()>=Date.parse(expires))throw new Error('This review expired. Open the original result or prepare a new action.');check.checked=false;b.disabled=true;await fn(valid);});b.disabled=true;
  check.onchange=()=>{b.disabled=!check.checked||Date.now()>=Date.parse(expires);};
  const ticket=generation;setTimeout(()=>{if(ticket===generation&&check.isConnected){b.disabled=true;check.disabled=true;check.checked=false;note('Review expired. Status remains available; execution requires a fresh valid review.');}},Math.max(0,Date.parse(expires)-Date.now()));
 };
 const readStatus=async valid=>{const value=await S.request(url(current.id)+'/status');if(valid())renderStatus(value);};
 function renderStatus(value){
  const p=start('3. Original action status'),approval=value.approval?.state?value.approval:value.approval?{state:value.state,approval:value.approval}:null;
  if(value.invocation){p.append(fields({'Invocation ID':current.id,'Result':value.invocation.type,'Admission':value.admission?.disposition,'Read-only status':value.readOnly??false,'Replayed result':value.replayed??false},true));details(p,'Action result and original evidence',{Result:value.invocation,Admission:value.admission,'Admission proof':value.admissionEvidence,'Invocation proof':value.invocationEvidence});}
  else if(approval){
   const proof=approval.approval;p.append(fields({'Invocation ID':current.id,'Approval state':approval.state,'Approval ID':proof?.approvalRef,'Approved by':proof?.approvedBy,'Approved at':proof?.approvedAt,'Approval expires':proof?.expiresAt},true));
   if(proof){p.append(el('p',proof.review.effectSummary));details(p,'Original approval proof',{Proof:proof});}
   note(approval.state==='pending'?'Review and approve this exact approval ID in PWCE Studio, then check its status here. Lifestream cannot approve it.':approval.state==='outcomeUnknown'?'The original request is unconfirmed. It will not be sent again automatically. Check its status; do not assume it failed.':approval.state==='approved'?'PWCE recorded approval. Review the approved action before running it.':'This approval cannot authorize a new action. Historical evidence is retained.');
   if(approval.state==='approved'&&current.record&&Date.parse(current.record.preparation.expiresAt)>Date.now())button(p,'Review approved action',async valid=>{const reviewed=await S.request(url(current.id)+'/review-approval',body());if(valid())renderApproved(reviewed);});
  }else{p.append(fields({'Invocation ID':current.id,'State':value.state||'Outcome unconfirmed'}));note('No effect is inferred from this status. Keep the original invocation ID for further checks.');}
  button(p,'Check original result',readStatus);
 }
 function renderApproved(value){
  const p=start('3. Review approved action');exact(p,current.record);p.append(fields({'Approval ID':value.approval.approvalRef,'Approved by':value.approval.approvedBy,'Approved at':value.approval.approvedAt,'Approval expires':value.approval.expiresAt},true));details(p,'Approved review evidence',{'Confirmation digest':value.approvalReviewDigest,'Producer proof':value.approval});
  confirmed(p,'Run approved action',valid=>execute('resume-approved',{...body(),approvalReviewDigest:value.approvalReviewDigest},valid),value.expiresAt);button(p,'Check original result',readStatus);note('This runs the exact approved action once. Reviewing this page has not run it.');
 }
 async function execute(operation,payload,valid){
  try{const result=await S.request(url(current.id)+'/'+operation,payload);if(!valid())return;renderStatus(result);}
  catch(error){if(valid()){const p=start('3. Check the original attempt');p.append(fields({'Invocation ID':current.id}));button(p,'Check original result',readStatus);note(`${error.message} The outcome is unconfirmed. Read the original status; this page will not resend the action automatically.`);}}
 }
 function renderReview(record){
  current={id:record.preparation.invocationId,record};remember(current.id);renderRecent();const p=start('2. Review the exact action');exact(p,record);
  const disposition=record.preparation.currentPreview.disposition;
  if(!record.confirmationAvailable)note('Execution is not configured for this host. You can inspect this preparation and its original status.');
  else if(disposition==='authorized'){confirmed(p,'Run reviewed action',valid=>execute('confirm',body(),valid),record.preparation.expiresAt);note('PWCE currently permits this action. Confirming runs it; preparation has not run it.');}
  else if(disposition==='approvalRequired'){confirmed(p,'Request PWCE approval',valid=>execute('request-approval',body(),valid),record.preparation.expiresAt);note('PWCE requires Human approval. Requesting it does not run the action.');}
  else note(`PWCE returned ${disposition}. This action cannot be run from this review.`);
  button(p,'Check original result',readStatus);
 }
 async function open(id,valid){
  current={id,record:null};try{const record=await S.request(url(id)+'/preparation');if(!valid())return;current={id,record};const status=await S.request(url(id)+'/status');if(valid()){if(status.state==='noRetainedAdmission')renderReview(record);else renderStatus(status);}}catch(error){if(!valid())return;if(error.status===409)await readStatus(valid);else throw error;}
 }
 function renderRecent(){
  recent().replaceChildren();const rows=references();if(!rows.length)return;const list=el('details');list.append(el('summary',`Retained actions in this session (${rows.length})`),el('p','Only invocation references are kept in this tab. The server rechecks ownership and authority when you open one.'));recent().append(list);
  list.append(table(['Invocation ID','Action'],rows.map(id=>{const b=el('button','Open original action','secondary');b.type='button';b.onclick=()=>{generation++;return run(valid=>open(id,valid))();};return [id,b];})));
 }
 async function prepare(tool,input){
  if(proposal)throw new Error('Resolve the existing preparation using its retry control first.');
  generation++;current=null;proposal={path:`${S.base()}/tools/${encodeURIComponent(tool.capabilityId)}/prepare`,body:{idempotencyKey:crypto.randomUUID(),capabilityVersion:tool.version,input}};await sendPreparation();
 }
 async function sendPreparation(){
  const pending=proposal,ticket=generation,epoch=S.epoch();$('cap-form').inert=true;const p=start('2. Preparing the exact action');note('Saving the original action for review. Nothing is being run.');
  try{const record=await S.request(pending.path,pending.body);if(ticket!==generation||epoch!==S.epoch())return;proposal=null;renderReview(record);}
  catch(error){if(ticket!==generation||epoch!==S.epoch())return;note(error.message);if(!error.status||error.status>=500)button(p,'Retry same preparation',()=>sendPreparation());else proposal=null;}
  finally{if(ticket===generation){$('cap-form').inert=!!proposal;if(!proposal&&!current)$('cap-pwce-entry').hidden=false;}}
 }
 function argumentsForm(schema,container){
  if(!schema.properties?.siteRef||!schema.properties?.targetEntityId||!schema.properties?.parameters?.properties?.level)throw new Error('This PWCE input shape is not supported by this form.');
  const values={};for(const [key,label,spec] of [['siteRef','Site',schema.properties.siteRef],['targetEntityId','Target',schema.properties.targetEntityId],['level','Brightness (0–1)',schema.properties.parameters.properties.level]]){const l=el('label',label),input=el('input');input.dataset.argument=key;input.required=true;input.type=key==='level'?'number':'text';if(key==='level'){input.min=spec.minimum;input.max=spec.maximum;input.step='any';}else{if(spec.maxLength)input.maxLength=spec.maxLength;if(spec.pattern)input.pattern=spec.pattern;}l.append(input);container.append(l);values[key]=input;}
  return ()=>({siteRef:values.siteRef.value,targetEntityId:values.targetEntityId.value,parameters:{level:Number(values.level.value)}});
 }
 function clear(){generation++;$('cap-pwce-entry').hidden=false;$('cap-status').hidden=false;$('cap-form').inert=false;current=null;proposal=null;feedback=null;panel().replaceChildren();panel().hidden=true;panel().inert=false;recent().replaceChildren();}
 window.addEventListener('lifestream-security-context',clear);
 window.lifestreamPwceActions={prepare,argumentsForm,renderRecent,clear};
})();
