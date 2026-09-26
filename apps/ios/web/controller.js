import {PresentationRuntime} from '../../control-web/presentation-runtime.js';

// The view owns no microphone, PCM queue, credential storage or background worker.
export function installApp(native) {
 const $=id=>document.getElementById(id);
 let session=null,context=null,catalog=null,renderer=null,nativeState={},epoch=0,privateAllowed=false,starting=false,refreshing=false,expires=0,startGeneration=0,appearanceLoad=null;
 const status=text=>{$('status').textContent=text;};
 const api=async(path,body)=>{
  const result=await native.request({path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value;try{value=JSON.parse(result.body);}catch{throw Error('Unexpected server response.');}
  if(result.status>=400)throw Error(value.message??value.code??'Request unavailable.');return value;
 };
 const clearDisplay=()=>{epoch++;appearanceLoad?.abort();appearanceLoad=null;renderer?.dispose();renderer=null;const canvas=$('avatar');canvas.replaceWith(canvas.cloneNode(false));$('transcript').replaceChildren();$('intro').hidden=false;};
 const protect=()=>{privateAllowed=false;expires=0;clearDisplay();catalog=null;$('appearance').replaceChildren(new Option('Neutral reference','neutral'));for(let i=1;i<$('assistant').options.length;i++)$('assistant').options[i].textContent=`Assistant ${i}`;$('privacy').textContent='Unknown/shared · private context withheld';};
 const controls=()=>{
  const active=!!nativeState.active;
  $('start').disabled=!session||!$('assistant').value||active||starting;
  $('stop').disabled=!active&&!starting;
  for(const id of ['assistant','background','private'])$(id).disabled=active||starting||!session;
  for(const id of ['appearance','apply-appearance'])$(id).disabled=active||starting||!session||!privateAllowed;
  $('shared').disabled=!session;$('sign-out').hidden=!session;$('session-panel').hidden=!session;
 };
 const run=fn=>async event=>{event?.preventDefault();try{await fn();}catch(error){status(error.message);}finally{controls();}};
 function message(role,text,trace,append=false){
  if(document.hidden||!privateAllowed)return;
  let entry=append?[...$('transcript').children].find(x=>x.dataset.trace===trace&&x.dataset.role===role):null;
  if(!entry){entry=document.createElement('li');entry.dataset.role=role;entry.dataset.trace=trace;entry.append(document.createElement('strong'),document.createElement('p'));entry.firstChild.textContent=role==='user'?'You':'Assistant';$('transcript').append(entry);while($('transcript').children.length>100)$('transcript').firstChild.remove();}
  entry.lastChild.textContent=((append?entry.lastChild.textContent:'')+text).slice(-64000);
 }
 async function render(item){
  if(!privateAllowed||document.hidden)return;if(item.manifest?.resources?.some(resource=>resource.bytes>64*1024*1024))throw Error('This iOS build supports appearance resources up to 64 MiB each.');const ticket=epoch;
  renderer??=new PresentationRuntime($('avatar'),{playback:()=>nativeState,identity:()=>({assistantId:$('assistant').value,endpointId:context?.endpoint?.endpointId}),onFailure:status,retrieveResource:async(path,signal)=>{signal?.throwIfAborted();const r=await native.request({path,method:'GET'});signal?.throwIfAborted();if(r.status!==200||r.encoding!=='base64')throw Error('Appearance resource unavailable.');return Uint8Array.from(atob(r.body),x=>x.charCodeAt(0)).buffer;}});
  const target=renderer,controller=appearanceLoad=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let value;try{value=await target.prepare(item,controller.signal);}finally{clearTimeout(timer);if(appearanceLoad===controller)appearanceLoad=null;}
  if(ticket!==epoch||!privateAllowed||document.hidden){target.release(value);return}target.commit(value);$('intro').hidden=true;
 }
 async function appearances(){
  const ticket=epoch,value=await api('/api/runtime/v1/presentation');if(ticket!==epoch||!privateAllowed)return;
  catalog=value;$('appearance').replaceChildren();for(const item of [catalog.neutral,...catalog.packages])$('appearance').add(new Option(item.label,item.id));
  const saved=catalog.selection?.override??catalog.selection?.default;
  const item=saved?[catalog.neutral,...catalog.packages].find(x=>x.id===saved.id&&x.digest===saved.digest):catalog.neutral;
  if(!item){status('Saved appearance is unavailable. Choose an available appearance.');return}
  $('appearance').value=item.id;await render(item);
 }
 async function checkAudience(){
  const ticket=epoch;
  try{
   const audience=await api('/api/runtime/v1/audience');if(ticket!==epoch)return;
   const expiry=audience.expiresAt?Date.parse(audience.expiresAt):0;
   if(audience.privateAllowed!==true||(audience.expiresAt&&(!Number.isFinite(expiry)||expiry<=Date.now()))){protect();return}
   privateAllowed=true;expires=expiry;$('privacy').textContent='Personal disclosure allowed temporarily';
  }catch(error){if(ticket===epoch)protect();throw error;}
 }
 async function refresh(){
  if(!session||refreshing)return;refreshing=true;
  try{
   const identity=session;context=await api('/api/runtime/v1/session-context');await checkAudience();
   const ticket=epoch,result=await api('/api/admin/v1/assistants');if(identity!==session||ticket!==epoch)return;
   const old=$('assistant').value;$('assistant').replaceChildren(new Option('Choose an Assistant',''));
   for(const [i,item] of (result.assistants??[]).entries()){
    const profile=item.profiles?.at(-1);$('assistant').add(new Option(privateAllowed?(profile?.corePersona?.canonicalName??profile?.displayName??profile?.name??`Assistant ${i+1}`):`Assistant ${i+1}`,item.assistantId));
   }
   $('assistant').value=old;if(!old&&$('assistant').options.length===2)$('assistant').selectedIndex=1;
   if(privateAllowed)await appearances();
  }finally{refreshing=false;controls();}
 }
 $('connection').onsubmit=run(async()=>{
  startGeneration++;protect();session=null;context=null;$('assistant').replaceChildren(new Option('Choose an Assistant',''));controls();
  await native.configure({endpoint:$('server').value.trim()});
  let account;try{account=await api('/api/auth/v1/sign-in',{username:$('username').value,password:$('password').value,...($('totp').value?{totp:$('totp').value}:{})});}finally{$('password').value='';$('totp').value='';}
  session=account.session;if(!session?.sessionId)throw Error("Server did not return a session.");const initial=await api('/api/runtime/v1/session-context');
  context=await api('/api/runtime/v1/session-context',{expectedRevision:initial.revision,bindingKey:crypto.randomUUID(),endpointClass:'personalCompanion',mode:'audio',audienceScope:'unknown'});
  $('connection').closest('details').open=false;status('Signed in. Private context is withheld until you choose Only me.');await refresh();
 });
 $('private').onclick=run(async()=>{
  protect();const current=await api('/api/runtime/v1/session-context');
  context=await api('/api/runtime/v1/session-context',{expectedRevision:current.revision,mode:'audio',audienceScope:'authenticatedSession'});
  await api('/api/runtime/v1/audience',{mode:'solo',seconds:300});await refresh();status('Only-me declaration lasts five minutes. It does not verify nearby people.');
 });
 $('shared').onclick=run(async()=>{
  startGeneration++;protect();await native.stop();const current=await api('/api/runtime/v1/session-context');
  await api('/api/runtime/v1/session-context',{expectedRevision:current.revision,mode:'audio',audienceScope:'unknown'});
  await api('/api/runtime/v1/audience',{mode:'shared',seconds:300});await refresh();status('Private context and display cleared.');
 });
 $('start').onclick=run(async()=>{
  const ticket=++startGeneration;starting=true;controls();try{const current=await api('/api/runtime/v1/session-context');if(ticket!==startGeneration)return;
   nativeState=await native.start({request:{sessionId:session.sessionId,expectedSessionRevision:current.revision,endpointId:current.endpoint.endpointId,assistantId:$('assistant').value},background:$('background').checked});status(nativeState.phase??'Connecting native audio…');
  }finally{if(ticket===startGeneration)starting=false;}
 });
 $('stop').onclick=run(async()=>{startGeneration++;starting=false;nativeState=await native.stop();status('Microphone and playback stopped.');});
 $('routes').onclick=run(()=>native.routePicker());
 $('refresh').onclick=run(refresh);
 $('assistant').onchange=run(async()=>{clearDisplay();if(privateAllowed)await appearances();});
 $('apply-appearance').onclick=run(async()=>{
  if(nativeState.active||starting||!privateAllowed)throw Error('Stop listening and review your audience before changing appearance.');
  const item=[catalog.neutral,...catalog.packages].find(x=>x.id===$('appearance').value);if(!item)throw Error('Choose an available appearance.');
  if(!renderer)throw Error('Refresh the display before applying an appearance.');if(item.manifest?.resources?.some(resource=>resource.bytes>64*1024*1024))throw Error('This iOS build supports appearance resources up to 64 MiB each.');
  const target=renderer,ticket=epoch,controller=appearanceLoad=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let candidate;
  try{
   candidate=await target.prepare(item,controller.signal);controller.signal.throwIfAborted();
   if(ticket!==epoch||!privateAllowed||nativeState.active||starting)throw Error('The conversation changed while loading.');
   const next=await api('/api/runtime/v1/presentation',{scope:'session',id:item.id,digest:item.digest,expectedRevision:catalog.selection?.override?.revision??catalog.selection?.overrideRevision??0});
   if(ticket!==epoch||!privateAllowed||document.hidden)throw Error('The audience changed while saving.');
   if(next.selection?.override?.id!==item.id||next.selection?.override?.digest!==item.digest)throw Error('The saved appearance changed. Refresh to review.');
   catalog=next;target.commit(candidate);candidate=null;$('intro').hidden=true;status('Appearance applied for this session.');
  }finally{if(candidate)target.release(candidate);clearTimeout(timer);if(appearanceLoad===controller)appearanceLoad=null;}
 });
 $('sign-out').onclick=run(async()=>{
  startGeneration++;protect();await native.stop();try{await api('/api/auth/v1/sign-out',{});}finally{session=null;nativeState={};$('connection').closest('details').open=true;status('Signed out.');}
 });
 void native.addListener('event',event=>{
  if(event.type==='state'){
   nativeState=event.state;$('route').textContent=event.state.route||'System route';status(event.state.phase);
   renderer?.applyState(event.state.playing?'speaking':event.state.active?'listening':'idle');
   if(/audience|authorization|sign-in/i.test(event.state.phase))protect();controls();
  }else if(event.type==='transcript')message('user',event.text,event.trace);else if(event.type==='textDelta')message('assistant',event.text,event.trace,true);
 });
 const privacyTimer=setInterval(()=>{
  if(document.hidden||!session)return;
  if(expires&&expires<=Date.now()){protect();controls();}
  if(!refreshing)void checkAudience().then(controls).catch(()=>controls());
 },1000);
 document.addEventListener('lifestream-native-resume',()=>{protect();controls();if(session)void refresh().catch(error=>status(error.message));});
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden){protect();}
  else void native.snapshot().then(value=>{nativeState=value;controls();if(session)return refresh();}).catch(error=>status(error.message));
 });
 window.addEventListener('pagehide',()=>{protect();clearInterval(privacyTimer);});
 controls();status('Connect to your existing private Assistant server.');
 return {refresh,api,get state(){return {session,privateAllowed,nativeState}}};
}
