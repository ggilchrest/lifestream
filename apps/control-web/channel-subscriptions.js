const element=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const channelName={telegram:'Telegram','ios-push':'iOS app notifications','android-push':'Android app notifications'};
/** Saved subscriber intent remains separate from pairing and live delivery. */
export function installChannelSubscriptions({anchor,api,scope}){
 const section=element('section');section.className='room-history';section.setAttribute('aria-label','Subscribers & chat destinations');
 section.innerHTML=`<h3>Subscribers & chat destinations</h3><p>Add destinations for yourself or other registered people. Each destination has separate conversation and alert permissions. Saving here does not connect a chat account or send anything.</p>
 <button type="button" data-channel-refresh class="secondary">Refresh subscribers</button><p data-channel-status role="status" aria-live="polite">Refresh to manage subscribers for this Assistant.</p>
 <form data-channel-form><fieldset data-channel-fields disabled><legend data-channel-title>Add a destination</legend><div class="form-grid">
 <label>Subscriber<select data-channel-person aria-label="Subscriber" required><option value="">Choose a registered person</option></select></label>
 <label>Channel<select data-channel-kind aria-label="Channel"><option value="telegram">Telegram</option><option value="ios-push">iOS app notifications — later</option><option value="android-push">Android app notifications — later</option></select></label>
 <label>Destination name<input data-channel-label required maxlength="80" autocomplete="off" placeholder="For example: my personal chat"></label></div>
 <label><input type="checkbox" data-channel-conversations> Request two-way Assistant conversations</label>
 <label><input type="checkbox" data-channel-alerts> Request while-away alerts</label>
 <p>Telegram pairing and connection are still required. Mobile delivery depends on the iOS/Android endpoints. These choices do not grant administration or evidence access.</p>
 <div class="actions"><button type="submit" data-channel-save>Save destination</button><button type="button" data-channel-cancel class="secondary" hidden>Cancel edit</button></div></fieldset></form>
 <div data-channel-list></div>`;anchor.append(section);
 const $=name=>section.querySelector(`[data-channel-${name}]`);let data=null,editing=null,busy=false,epoch=0;
 const identity=()=>{if(document.hidden||location.hash!=='#conversation'||document.documentElement.dataset.audienceProtected!=='false')throw Error('Use a visible private conversation to manage subscribers.');return JSON.stringify(scope());};
 const message=text=>{$('status').textContent=text;};
 const controls=()=>{$('refresh').disabled=busy;$('fields').disabled=busy||!data;$('person').disabled=!!editing;$('kind').disabled=!!editing;$('conversations').disabled=$('kind').value!=='telegram';for(const button of $('list').querySelectorAll('button'))button.disabled=busy;};
 const reset=()=>{editing=null;$('form').reset();$('title').textContent='Add a destination';$('cancel').hidden=true;controls();};
 const grantControls=(item,card)=>{
  if(!data.alertGrantConfigurationAvailable||item.connection?.pairingState!=='paired'||!item.connection.alertsEnabled)return;
  const pane=element('section');pane.setAttribute('aria-label','Alert permission for '+item.label);card.append(pane);
  const button=(label,action)=>{const b=element('button',label);b.type='button';b.className='secondary';b.onclick=()=>run(action);return b;};
  const path='/api/runtime/v1/telegram-notice-authority?'+new URLSearchParams({assistantId:scope().assistantId,subscriptionId:item.id});
  const fetchGrant=async body=>{const ticket=epoch,key=identity(),result=await api(path,body?{method:'POST',body:JSON.stringify(body)}:undefined);if(ticket!==epoch||key!==identity()||!pane.isConnected)return null;return result;};
  const show=result=>{
   pane.replaceChildren(element('h5','Permission to send alerts'));
   pane.append(element('p',result.current?'Permission active. Incident classes, quiet hours and subscriber consent still apply.':result.grant?'Permission is inactive or needs review. No alert is authorized by this grant.':'No alert permission granted.'));
   if(result.grant){pane.append(element('p',`Grant ${result.grant.status}. Expires ${new Date(result.grant.expiresAt).toLocaleString()}; review due ${new Date(result.grant.reviewAfter).toLocaleString()}.`));if(result.grant.status==='active')pane.append(button('Revoke alert permission',async()=>{const next=await fetchGrant({operation:'revoke',grantId:result.grant.grantId,expectedRevision:result.grant.revision});if(next){show(next);message('Alert permission revoked. Delivery already accepted cannot be recalled.');}}));}
   const label=element('label','Permission duration '),duration=element('select');duration.setAttribute('aria-label','Alert permission duration for '+item.label);for(const days of [1,7,30])duration.add(new Option(days+' day'+(days===1?'':'s'),String(days)));duration.value='7';label.append(duration);pane.append(label);
   pane.append(element('p','Only fixed, redacted notices are allowed. No incident details, media or memory are sent. Logout, revoked consent, pairing changes and the review deadline stop sends. This does not extend administrator access.'));
   pane.append(button('Prepare alert permission',async()=>{
    const expiresAt=new Date(Date.now()+Number(duration.value)*86400000).toISOString(),next=await fetchGrant({operation:'request',expiresAt,reviewAfter:expiresAt});if(!next)return;
    const pending=next.request;pane.replaceChildren(element('h5','Review alert permission'),element('p',pending.effectSummary),element('p',`Recipient: ${item.label}. Expires and needs review: ${new Date(pending.grantExpiresAt).toLocaleString()}. This review expires ${new Date(pending.expiresAt).toLocaleTimeString()}.`));
    pane.append(button('Approve alert permission',async()=>{const approved=await fetchGrant({operation:'approve',requestId:pending.requestId,expectedRevision:pending.revision,confirmationDigest:pending.confirmationDigest});if(approved){show(approved);message('Alert permission approved. Refresh while-away alerts to choose incident classes.');}}),button('Cancel permission review',async()=>{const cancelled=await fetchGrant({operation:'cancel',requestId:pending.requestId,expectedRevision:pending.revision});if(cancelled){show(cancelled);message('Permission review cancelled.');}}));
   }));
  };
  pane.append(button('Review alert permission',async()=>{const result=await fetchGrant();if(result)show(result);}));
 };
 const render=()=>{
  $('person').replaceChildren(new Option('Choose a registered person',''));for(const a of data?.accounts??[])$('person').add(new Option(a.username,a.principalId));$('list').replaceChildren();
  const records=data?.subscriptions??[];if(!records.length)$('list').append(element('p','No destinations saved. Create accounts in Account first if you need another subscriber.'));
  for(const item of records){const card=element('article');card.className='record-card';card.append(element('h4',item.label),element('p',`${data.accounts.find(a=>a.principalId===item.principalId)?.username??'Unavailable account'} · ${channelName[item.channel]}`),element('p',item.status==='removed'?'Removed · history retained':item.status==='disabled'?'Disabled · no requested permissions':item.channel==='telegram'?(item.connection?.pairingState==='paired'?'Paired · '+(item.connection.transportReady?'host connected':'host unavailable'):'Pairing: '+(item.connection?.pairingState??'unavailable')):'Deferred · mobile endpoint required'),element('p',`Requested: conversations ${item.requestedConversations?'on':'off'}; alerts ${item.requestedAlerts?'on':'off'}.`));
   if(item.independentlyAdministered)card.append(element('p','This person already administers the Assistant. Their owned relationship uses its existing personal-context and memory controls.'));
   if(item.personalContext&&!item.independentlyAdministered&&item.status!=='removed'){const p=item.personalContext;card.append(element('p',`Personal context for this person across their eligible destinations: ${p.ownerAllowed?'permitted':'not permitted'}; subscriber consent ${p.consented?'given':'not given'}. Automatic memory is their separate choice.`));const b=element('button',p.ownerAllowed?'Revoke personal context':'Permit personal context');b.type='button';b.className='secondary';b.onclick=()=>run(()=>mutate({operation:'personalContext',principalId:item.principalId,expectedRevision:p.revision,allowed:!p.ownerAllowed},'Personal context permission updated. Fresh subscriber consent is required; no administrator access granted.'));card.append(b);}
   if(item.connection?.pairingState==='paired')card.append(element('p',`Subscriber consent: conversations ${item.connection.conversationsEnabled?'enabled':'disabled'}; alerts ${item.connection.alertsEnabled?'enabled':'disabled'}. ${data.alertCompositionConfigured?'Owner alert classes and current authority still apply.':'Alert authority is not configured at this host.'}`));
   if(item.status!=='removed'){const actions=element('div');actions.className='actions';for(const [operation,label] of [['edit','Edit destination'],['disable','Disable destination'],['remove','Remove destination']]){const button=element('button',label);button.type='button';button.className='secondary';button.onclick=operation==='edit'?()=>{editing=item;$('title').textContent='Edit destination';$('person').value=item.principalId;$('kind').value=item.channel;$('label').value=item.label;$('conversations').checked=item.requestedConversations;$('alerts').checked=item.requestedAlerts;$('cancel').hidden=false;controls();$('label').focus();}:()=>run(()=>mutate({operation,id:item.id,expectedRevision:item.revision},operation==='remove'?'Destination removed; history retained.':'Destination disabled.'));actions.append(button);}card.append(actions);}grantControls(item,card);$('list').append(card);
  }reset();
 };
 const fetchData=async body=>{const key=identity(),ticket=epoch,next=await api('/api/runtime/v1/channel-subscriptions?'+new URLSearchParams({assistantId:scope().assistantId}),body?{method:'POST',body:JSON.stringify(body)}:undefined);if(ticket!==epoch||key!==identity())return false;data=next;render();return true;};
 const run=async task=>{if(busy)return;const ticket=epoch;busy=true;controls();try{identity();await task();}catch(error){if(ticket===epoch)message(error.message);}finally{if(ticket===epoch){busy=false;controls();}}};
 const mutate=async(body,text)=>{message('Saving destination…');if(await fetchData(body))message(text);};
 $('refresh').onclick=()=>run(async()=>{if(await fetchData())message('Subscriber settings loaded. '+(data.transportReady?'Telegram host connected.':data.transportConfigured?'Telegram host configured but unavailable or disabled.':'Telegram host not configured.'));});
 $('cancel').onclick=()=>{reset();$('conversations').disabled=false;};
 $('kind').onchange=()=>{$('conversations').disabled=$('kind').value!=='telegram';if($('conversations').disabled)$('conversations').checked=false;};
 $('form').onsubmit=event=>{event.preventDefault();void run(()=>mutate({operation:editing?'update':'create',...(editing?{id:editing.id,expectedRevision:editing.revision}:{principalId:$('person').value,channel:$('kind').value}),label:$('label').value,requestedConversations:$('conversations').checked,requestedAlerts:$('alerts').checked},'Destination saved. Pairing and connection remain pending.'));};
 const clear=()=>{epoch++;busy=false;data=null;editing=null;$('list').replaceChildren();$('person').replaceChildren(new Option('Choose a registered person',''));reset();message('Refresh to manage subscribers for this Assistant.');};
 for(const event of ['lifestream-auth','lifestream-assistant','lifestream-session-context','lifestream-audience','hashchange','pagehide'])window.addEventListener(event,clear);document.addEventListener('visibilitychange',clear);
 return {clear};
}
