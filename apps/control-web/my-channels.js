const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
/** Account controls reveal only the signed-in subscriber's destinations. */
export function installMyChannels({anchor,api,identity}){
 const panel=el('section');panel.className='memory-tools';panel.setAttribute('aria-label','My chat connections');panel.innerHTML='<h3>My chat connections</h3><p>Pair only your own private Telegram chat. The account owner chooses the permitted features; you control pairing. Pairing does not start delivery. Keep pairing codes private.</p><button type="button" data-mine-refresh class="secondary">Refresh my connections</button><p data-mine-status role="status">Sign in and refresh to see your destinations.</p><div data-mine-list></div>';anchor.append(panel);
 const $=s=>panel.querySelector('[data-mine-'+s+']');let epoch=0,busy=false;
 const key=()=>{if(document.hidden)throw Error('Open this page to manage your connections.');const v=identity();if(!v)throw Error('Sign in to manage your connections.');return v;};
 const status=text=>{$('status').textContent=text;};
 const controls=()=>{for(const b of panel.querySelectorAll('button,input'))b.disabled=busy;};
 const clear=()=>{epoch++;busy=false;$('list').replaceChildren();status('Sign in and refresh to see your destinations.');controls();};
 const render=(data)=>{
  $('list').replaceChildren();if(!data.subscriptions.length)$('list').append(el('p','No destinations assigned. Ask the owner to add one for your account.'));
  for(const s of data.subscriptions){const card=el('article');card.className='record-card';card.append(el('h4',s.label),el('p',s.channel+' · '+(s.pairing?.state??s.status)),el('p','Permitted by owner: conversations '+(s.requestedConversations?'on':'off')+'; alerts '+(s.requestedAlerts?'on':'off')+'.'));
   const p=s.pairing;if(p){
    const label=el('label','Telegram bot numeric ID (not its secret token)'),input=el('input');input.inputMode='numeric';input.setAttribute('aria-label','Telegram bot numeric ID');input.value=p.botId??'';label.append(input);card.append(label);
    const actions=el('div');actions.className='actions';const button=(title,task)=>{const b=el('button',title);b.type='button';b.className='secondary';b.onclick=()=>run(task);actions.append(b);};
    button(p.state==='unpaired'?'Create pairing code':'Replace pairing code',()=>load({operation:'issue',id:s.id,expectedRevision:s.revision,pairingRevision:p.revision,botId:input.value.trim()}));
    if(p.state==='claimed'){card.append(el('p',`Telegram user ${p.userId}, private chat ${p.chatId}. Confirm only if this is the chat where you entered your code.`));button('Confirm my Telegram chat',()=>load({operation:'confirm',id:s.id,expectedRevision:p.revision,claimId:p.claimId}));}
    if(p.revision>0&&p.state!=='revoked')button('Revoke pairing',()=>load({operation:'revoke',id:s.id,expectedRevision:p.revision}));
    if(p.state==='paired')card.append(el('p','Paired. Delivery remains disabled until the transport and separate feature permissions are enabled.'));
    if(data.issued?.subscriptionId===s.id){const code=el('code','/start '+data.issued.challenge);code.style.overflowWrap='anywhere';card.append(el('p','In your private chat with that bot, send this command within ten minutes. Then refresh here and verify the claimed chat.'),code);}
    card.append(actions);
   }else if(s.channel!=='telegram')card.append(el('p','Mobile notification endpoints are deferred.'));$('list').append(card);
  }
 };
 const load=async body=>{const before=key(),ticket=epoch;status(body?'Updating pairing…':'Refreshing connections…');const data=await api('/api/runtime/v1/my-channel-pairings',body?{method:'POST',body:JSON.stringify(body)}:undefined);if(ticket!==epoch||before!==key())return;render(data);status(data.issued?'Pairing code created. No connection started.':'Connections refreshed. No messages sent.');};
 const run=async task=>{if(busy)return;const ticket=epoch;busy=true;controls();try{await task();}catch(e){if(ticket===epoch)status(e.message);}finally{if(ticket===epoch){busy=false;controls();}}};
 $('refresh').onclick=()=>run(()=>load());for(const event of ['lifestream-auth','pagehide','hashchange'])window.addEventListener(event,clear);document.addEventListener('visibilitychange',clear);return {clear};
}
