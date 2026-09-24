const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;};
const clock=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
const minutes=value=>{if(!/^\d{2}:\d{2}$/.test(value))throw Error('Choose both quiet-hour times.');const [h,m]=value.split(':').map(Number);return h*60+m;};

/** Background configuration is independent of the conversation event stream.
 * Clearing private UI state does not revoke a saved notification opt-in. */
export function installUrgentAway({anchor,api,scope}){
 const section=node('section');section.className='room-history room-away';section.setAttribute('aria-label','While-away alerts');
 section.innerHTML=`<h3>While-away alerts</h3><p>Choose an already configured private notification destination. Saved settings run on the host while this page is closed. They send a generic notice; sign in to review evidence. Transport acceptance does not confirm that you saw an alert.</p>
 <p data-away-status role="status" aria-live="polite">Refresh to inspect configured destinations. No destination is selected.</p>
 <button type="button" data-away-refresh class="secondary">Refresh while-away status</button>
 <label>Notification destination<select data-away-destination disabled><option value="">Choose a destination</option></select></label>
 <form data-away-form><fieldset data-away-settings disabled><legend>While-away interruption settings</legend><div data-away-rules></div>
 <label><input type="checkbox" data-away-quiet> Use scheduled quiet hours</label><div class="form-grid" data-away-hours hidden><label>Quiet hours start<input type="time" data-away-start value="22:00"></label><label>Quiet hours end<input type="time" data-away-end value="07:00"></label><label>Quiet hours time zone<input data-away-zone value="UTC" maxlength="100"></label></div>
 <p class="muted">Each class and its quiet-hour bypass is a separate choice. Snooze, current authority and privacy still apply. Saved settings never replay an old alert.</p><button type="submit" data-away-save>Save while-away settings</button></fieldset></form>
 <div class="actions"><label>Snooze duration<select data-away-minutes><option value="15">15 minutes</option><option value="60">1 hour</option><option value="480">8 hours</option></select></label><button type="button" data-away-snooze class="secondary" disabled>Snooze while-away alerts</button><button type="button" data-away-disable class="secondary" disabled>Disable while-away alerts</button></div>
 <p data-away-summary class="muted">Remote delivery is not configured.</p><details><summary>While-away delivery history</summary><p>No automatic resend follows an uncertain outcome. Acknowledgment records your review and does not resolve the source condition.</p><div data-away-history></div></details>`;
 anchor.append(section);const $=name=>section.querySelector(`[data-away-${name}]`);let data=null,selected='',busy=false,generation=0;
 const identity=()=>{if(document.hidden||location.hash!=='#conversation'||document.documentElement.dataset.audienceProtected!=='false')throw Error('Use a visible private conversation to administer while-away alerts.');return JSON.stringify(scope());};
 const path=()=>'/api/runtime/v1/urgent/away?'+new URLSearchParams({assistantId:scope().assistantId});
 const current=()=>data?.destinations.find(d=>d.destinationRef===selected);
 const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
 const controls=()=>{const ready=!!current();$('refresh').disabled=busy;$('destination').disabled=busy||!data?.destinations.length;$('settings').disabled=busy||!ready;$('snooze').disabled=busy||!ready;$('disable').disabled=busy||!ready;};
 const render=()=>{
  $('destination').replaceChildren(new Option('Choose a destination',''));for(const d of data?.destinations??[])$('destination').add(new Option(d.destinationRef,d.destinationRef));$('destination').value=selected;
  $('rules').replaceChildren();$('history').replaceChildren();const d=current();
  if(!d){$('summary').textContent=data?.destinations.length?'Select a destination to review its saved policy.':'Remote delivery is not configured. Configure an authorized destination at the host before enabling alerts.';controls();return;}
  for(const binding of d.bindings){const rule=d.settings.rules.find(r=>r.sourceRef===binding.sourceRef&&r.eventClass===binding.eventClass),row=node('fieldset');row.dataset.sourceRef=binding.sourceRef;row.dataset.eventClass=binding.eventClass;row.append(node('legend',binding.label));for(const [key,text,value] of [['enabled','Allow this class to notify this destination',rule?.enabled],['bypass','Allow this class during quiet hours',rule?.bypassQuietHours]]){const label=node('label'),input=node('input');input.type='checkbox';input.dataset['away'+key[0].toUpperCase()+key.slice(1)]='';input.checked=value===true;label.append(input,document.createTextNode(' '+text));row.append(label);}$('rules').append(row);}
  const q=d.settings.quietHours;$('quiet').checked=!!q;$('hours').hidden=!q;if(q){$('start').value=clock(q.startMinute);$('end').value=clock(q.endMinute);$('zone').value=q.timeZone;}
  const worker=d.worker.destinations.find(item=>item.destinationRef===d.destinationRef);
  $('summary').textContent=`Revision ${d.settings.revision} · ${d.settings.rules.filter(r=>r.enabled).length} enabled class(es) · ${worker?.connected?'Source connected':worker?.reason??'Unavailable'}${d.settings.snoozedUntil?' · Snoozed until '+d.settings.snoozedUntil:''}. Closing this page leaves saved background settings in effect.`;
  for(const delivery of d.worker.deliveries){const card=node('article');card.className='record-card';card.append(node('h4',delivery.state==='accepted'?'Transport accepted':delivery.state==='unknown'?'Delivery outcome unknown':delivery.state),node('p',`Attempted: ${delivery.attemptedAt??'not attempted'} · Transport accepted: ${delivery.acceptedAt??'not observed'}`),node('p',`Condition ${delivery.conditionRef} · ${delivery.reason??'pending'}`),node('p',delivery.acknowledgedAt?'Human acknowledged: '+delivery.acknowledgedAt:'Human acknowledgment not recorded.'));
   if(!delivery.acknowledgedAt&&delivery.state==='accepted'){const ack=node('button','Acknowledge while-away alert');ack.type='button';ack.dataset.awayAck=delivery.id;ack.onclick=run(()=>mutate({operation:'acknowledge',deliveryId:delivery.id,expectedRevision:delivery.revision},'Your acknowledgment is recorded. The source condition is unchanged.'));card.append(ack);}$('history').append(card);}
  if(!d.worker.deliveries.length)$('history').append(node('p','No delivery attempts recorded.'));
  for(const item of d.conditions??[]){if(!item.reasons?.length)continue;const card=node('article');card.className='record-card';card.append(node('h4','Condition withheld'),node('p',`${item.condition.conditionRef} · ${item.condition.eventClass}`),node('p',item.reasons.join(', ')));$('history').append(card);}
  controls();
 };
 const reset=()=>{generation++;data=null;selected='';busy=false;render();status('Private details cleared. Saved background settings remain in effect; refresh to review them.');};
 const fetchData=async(options)=>{const key=identity(),ticket=generation,next=await api(path(),options);if(ticket!==generation||key!==identity())return false;data=next;if(!data.destinations.some(d=>d.destinationRef===selected))selected='';render();return true;};
 const run=fn=>async event=>{event?.preventDefault();if(busy)return;const ticket=generation;busy=true;controls();try{await fn();}catch(error){if(ticket===generation)status(error.message,true);}finally{if(ticket===generation){busy=false;controls();}}};
 const mutate=async(body,message)=>{if(!current())throw Error('Select a configured destination.');if(await fetchData({method:'POST',body:JSON.stringify({...body,destinationRef:selected})}))status(message);};
 $('refresh').onclick=run(async()=>{if(await fetchData())status(data.destinations.length?'Current destination policies loaded. Refresh does not send or replay alerts.':'No authorized while-away destination is configured.');});
 $('destination').onchange=()=>{selected=$('destination').value;render();};
 $('quiet').onchange=()=>{$('hours').hidden=!$('quiet').checked;};
 $('form').onsubmit=run(async()=>{const d=current();if(!d)throw Error('Select a destination.');const quietHours=$('quiet').checked?{startMinute:minutes($('start').value),endMinute:minutes($('end').value),timeZone:$('zone').value.trim()}:null;if(quietHours){if(quietHours.startMinute===quietHours.endMinute)throw Error('Quiet hours must have different start and end times.');try{new Intl.DateTimeFormat('en',{timeZone:quietHours.timeZone});}catch{throw Error('Enter a valid quiet-hours time zone.');}}
  await mutate({operation:'configure',expectedRevision:d.settings.revision,modality:'text',quietHours,snoozedUntil:d.settings.snoozedUntil,rules:[...$('rules').children].map(row=>({sourceRef:row.dataset.sourceRef,eventClass:row.dataset.eventClass,enabled:row.querySelector('[data-away-enabled]').checked,bypassQuietHours:row.querySelector('[data-away-bypass]').checked}))},'While-away settings saved. Host delivery continues while this page is closed.');});
 $('snooze').onclick=run(()=>mutate({operation:'control',action:'snooze',expectedRevision:current().settings.revision,until:new Date(Date.now()+Number($('minutes').value)*60000).toISOString()},'While-away alerts are snoozed. Missed conditions will not replay.'));
 $('disable').onclick=run(()=>mutate({operation:'control',action:'disable',expectedRevision:current().settings.revision},'While-away alerts disabled for this destination.'));
 for(const event of ['lifestream-auth','lifestream-assistant','lifestream-relationship','lifestream-session-context','lifestream-audience'])window.addEventListener(event,reset);
 window.addEventListener('hashchange',()=>{if(location.hash!=='#conversation')reset();});document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});window.addEventListener('pagehide',reset);
 return {reset};
}
