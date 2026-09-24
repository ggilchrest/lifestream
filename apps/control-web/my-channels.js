const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
/** Account controls reveal only the signed-in subscriber's destinations. */
export function installMyChannels({anchor,api,identity}){
 const panel=el('section');panel.className='memory-tools';panel.setAttribute('aria-label','My chat connections');panel.innerHTML='<h3>My chat connections</h3><p>Pair only your own private Telegram chat. The account owner chooses the permitted features; you control pairing. Pairing does not start delivery. Keep pairing codes private.</p><button type="button" data-mine-refresh class="secondary">Refresh my connections</button><p data-mine-status role="status">Sign in and refresh to see your destinations.</p><div data-mine-list></div>';anchor.append(panel);
 const $=s=>panel.querySelector('[data-mine-'+s+']');let epoch=0,busy=false;
 const key=()=>{if(document.hidden)throw Error('Open this page to manage your connections.');const v=identity();if(!v)throw Error('Sign in to manage your connections.');return v;};
 const status=text=>{$('status').textContent=text;};
 const controls=()=>{for(const b of panel.querySelectorAll('button,input,textarea,select'))b.disabled=busy;};
 const clear=()=>{epoch++;busy=false;$('list').replaceChildren();status('Sign in and refresh to see your destinations.');controls();};
 const personalControls=(s,card)=>{
  if(!s.assistantId)return;
  const pane=el('section');pane.setAttribute('aria-label','My personal context for '+s.label);card.append(pane);
  const path='/api/runtime/v1/my-personal-context?'+new URLSearchParams({assistantId:s.assistantId});
  const privateKey=()=>{const k=key();if(document.documentElement.dataset.audienceProtected!=='false')throw Error('Select a personal session and declare a private audience before reviewing memory.');return k;};
  const fetchPersonal=async body=>{const before=privateKey(),ticket=epoch;const data=await api(path,body?{method:'POST',body:JSON.stringify(body)}:undefined);if(ticket!==epoch||before!==privateKey()||!pane.isConnected)return null;return data;};
  const button=(label,task)=>{const b=el('button',label);b.type='button';b.className='secondary';b.onclick=()=>run(task);return b;};
  const refresh=async()=>{const data=await fetchPersonal();if(data)show(data);};
  const show=data=>{
   pane.replaceChildren(el('h5','My personal context'),el('p','These settings apply to your relationship with this Assistant across your eligible chat destinations. They grant no administrator access. A private audience is still required in each chat.'));
   const p=data.permission;pane.append(el('p',p.ownerAllowed?(p.consented?'You have consented to personal context.':'The owner permits personal context; your consent is still required.'):'The owner has not permitted personal context. You can still review and remove your retained memories.'));
   if(p.consented||p.ownerAllowed&&data.eligible)pane.append(button(p.consented?'Withdraw my context consent':'Consent to my personal context',async()=>{const next=await fetchPersonal({operation:'consent',enabled:!p.consented,expectedRevision:p.revision});if(next)show(next);}));
   if(data.memory){const policy=data.memory.policy;pane.append(el('p',policy.enabled?'Automatic memory collection enabled.':'Automatic memory collection stopped. Existing memories remain until corrected or forgotten.'));
    if(policy.enabled||p.ownerAllowed&&p.consented&&data.eligible)pane.append(button(policy.enabled?'Stop automatic memory':'Enable automatic memory',async()=>{const next=await fetchPersonal({operation:'collection',enabled:!policy.enabled,expectedRevision:policy.revision});if(next)show(next);}));
    pane.append(el('p','Recent collection work: '+(data.memory.jobs.map(j=>j.state).join(', ')||'none')));
   }
   pane.append(button('Refresh my memory',refresh));
   for(const receipt of data.privacyReceipts??[])if(receipt.retryRequired)pane.append(el('p','Privacy cleanup is pending; affected use is withheld.'),button('Retry privacy cleanup',async()=>{const next=await fetchPersonal({operation:'retryPrivacy',operationId:receipt.operationId});if(next)await refresh();}));
   for(const memory of data.memories){const row=el('article');row.className='record-card';row.append(el('p',memory.content),el('p',`Status: ${memory.lifecycle.status}; confidence: ${memory.lifecycle.confidence}; source: ${memory.provenance.source??'unavailable'}.`));
    if(['active','candidate'].includes(memory.lifecycle.status)){
     const label=el('label','Correct this memory'),input=el('textarea');input.setAttribute('aria-label','Correct this memory');input.maxLength=4000;input.value=memory.content;label.append(input);row.append(label);
     row.append(button('Review correction',async()=>{const result=await fetchPersonal({operation:'correct',id:memory.id,content:input.value,expectedRevision:memory.lifecycle.revision});if(!result)return;const review=el('div');review.append(el('p','Proposed correction: '+result.event.payload.proposedContent),button('Apply my correction',async()=>{const applied=await fetchPersonal({operation:'applyCorrection',id:memory.id,applyRevision:result.event.revision,expectedRevision:memory.lifecycle.revision});if(applied)await refresh();}),button('Cancel correction review',()=>{review.remove();}));row.append(review);}));
    }
    if(!memory.lifecycle.contentRemoved){row.append(button('Review forgetting',async()=>{const request={id:memory.id,expectedRevision:memory.lifecycle.revision,relationshipRevision:data.relationshipRevision,idempotencyKey:crypto.randomUUID()},result=await fetchPersonal({operation:'forgetPreview',...request});if(!result)return;const review=el('div');review.append(el('p','Forget this memory and withhold dependent personal context. Retained safety evidence prevents replay from backup. External copies cannot be erased.'),button('Confirm forget my memory',async()=>{const applied=await fetchPersonal({operation:'forget',...request});if(applied)await refresh();}),button('Cancel forgetting',()=>{review.remove();}));row.append(review);}));
    }pane.append(row);
   }
  };
  pane.append(button('Review my personal context',refresh));
 };
 const render=(data)=>{
  $('list').replaceChildren();if(!data.subscriptions.length)$('list').append(el('p','No destinations assigned. Ask the owner to add one for your account.'));
  for(const s of data.subscriptions){const card=el('article');card.className='record-card';card.append(el('h4',s.label),el('p',s.channel+' · '+(s.pairing?.state??s.status)),el('p','Permitted by owner: conversations '+(s.requestedConversations?'on':'off')+'; alerts '+(s.requestedAlerts?'on':'off')+'.'));
   const p=s.pairing;if(p){
    const label=el('label','Telegram bot numeric ID (not its secret token)'),input=el('input');input.inputMode='numeric';input.setAttribute('aria-label','Telegram bot numeric ID');input.value=p.botId??data.configuredBotId??'';label.append(input);card.append(label);
    const actions=el('div');actions.className='actions';const button=(title,task)=>{const b=el('button',title);b.type='button';b.className='secondary';b.onclick=()=>run(task);actions.append(b);};
    button(p.state==='unpaired'?'Create pairing code':'Replace pairing code',()=>load({operation:'issue',id:s.id,expectedRevision:s.revision,pairingRevision:p.revision,botId:input.value.trim()}));
    if(p.state==='claimed'){card.append(el('p',`Telegram user ${p.userId}, private chat ${p.chatId}. Confirm only if this is the chat where you entered your code.`));button('Confirm my Telegram chat',()=>load({operation:'confirm',id:s.id,expectedRevision:p.revision,claimId:p.claimId}));}
    if(p.revision>0&&p.state!=='revoked')button('Revoke pairing',()=>load({operation:'revoke',id:s.id,expectedRevision:p.revision}));
    if(p.state==='paired'){card.append(el('p',p.conversationsEnabled?'Conversations enabled. Audience starts unknown. In your private bot chat, /private declares that only you can see it for five minutes; /shared withholds personal context immediately; /privacy checks the state. Only your own independently approved context and memory policy can apply.':'Paired. Delivery remains disabled until the transport and separate feature permissions are enabled.'));if(p.conversationsEnabled||data.conversationsAvailable&&p.botId===data.configuredBotId&&s.requestedConversations)button(p.conversationsEnabled?'Disable conversations':'Enable conversations',()=>load({operation:'enable',id:s.id,expectedRevision:p.revision,conversations:!p.conversationsEnabled}));card.append(el('p',p.alertsEnabled?'Alert consent is enabled. '+(s.alert?.requiresOwnerPolicy?'The owner must select alert classes.':s.alert?.configured?'Owner class policy and quiet hours still apply.':'The host alert route is unavailable.'):'Alert delivery is disabled. Conversation permission does not enable alerts.'));
     if(p.alertsEnabled||data.alertsAvailable&&p.botId===data.configuredBotId&&s.requestedAlerts)button(p.alertsEnabled?'Disable alerts':'Enable alerts',()=>load({operation:'alerts',id:s.id,expectedRevision:p.revision,alerts:!p.alertsEnabled}));}
    if(data.issued?.subscriptionId===s.id){const code=el('code','/start '+data.issued.challenge);code.style.overflowWrap='anywhere';card.append(el('p','In your private chat with that bot, send this command within ten minutes. Then refresh here and verify the claimed chat.'),code);}
    card.append(actions);
   }else if(s.channel!=='telegram')card.append(el('p','Mobile notification endpoints are deferred.'));for(const delivery of s.alert?.deliveries??[]){const row=el('article');row.append(el('p',`Alert: ${delivery.state}. Transport accepted: ${delivery.acceptedAt??'not observed'}. ${delivery.acknowledgedAt?'Acknowledged: '+delivery.acknowledgedAt:'Not acknowledged.'}`));if(delivery.state==='accepted'&&!delivery.acknowledgedAt){const ack=el('button','Acknowledge my alert');ack.type='button';ack.onclick=()=>run(()=>load({operation:'acknowledge',id:s.id,deliveryId:delivery.id,expectedRevision:delivery.revision}));row.append(ack);}card.append(row);}if(data.personalContextAvailable){if(s.independentlyAdministered)card.append(el('p','Your administrator-owned relationship uses its existing personal-context and memory controls in Conversation and Records.'));else personalControls(s,card);}$('list').append(card);
  }
 };
 const load=async body=>{const before=key(),ticket=epoch;status(body?'Updating pairing…':'Refreshing connections…');const data=await api('/api/runtime/v1/my-channel-pairings',body?{method:'POST',body:JSON.stringify(body)}:undefined);if(ticket!==epoch||before!==key())return;render(data);status(data.issued?'Pairing code created. No connection started.':body?.operation==='enable'?'Conversation permission updated.':body?.operation==='alerts'?'Alert consent updated. Owner class policy remains separate.':body?.operation==='acknowledge'?'Your acknowledgment is recorded. The source condition is unchanged.':'Connection settings refreshed.');};
 const run=async task=>{if(busy)return;const ticket=epoch;busy=true;controls();try{await task();}catch(e){if(ticket===epoch)status(e.message);}finally{if(ticket===epoch){busy=false;controls();}}};
 $('refresh').onclick=()=>run(()=>load());for(const event of ['lifestream-auth','lifestream-session-context','lifestream-audience','pagehide','hashchange'])window.addEventListener(event,clear);document.addEventListener('visibilitychange',clear);return {clear};
}
