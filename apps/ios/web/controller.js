import {bundledAppearances,bundledResource} from './bundled-appearances.js';
import {animationKey,animationChoices,resolveAppearance} from './animation-preferences.js';
import {renderActivity} from './activity.js';
import {PresentationRuntime} from '../../control-web/presentation-runtime.js';

// The view owns no microphone, PCM queue, credential storage or background worker.
export function installApp(native) {
 const $=id=>document.getElementById(id);
 let session=null,context=null,catalog=null,renderer=null,nativeState={},epoch=0,privateAllowed=false,starting=false,refreshing=false,expires=0,startGeneration=0,appearanceLoad=null;
 const selections=new Map();let disabledAnimations={},rememberedAssistant='',connectionGeneration=0,restoring=false,savedIdentity='',textGeneration=0,textState={},audienceGeneration=0,declaringAudience=0,audienceLeaseId=null;
 const pane=settings=>{$('settings-pane').hidden=!settings;$('main-pane').hidden=settings;$('open-settings').hidden=settings;$('open-settings').setAttribute('aria-expanded',String(settings));if(settings)$('settings-title').focus();window.scrollTo({top:0,behavior:'instant'});};
 const saveSettings=()=>native.saveSettings({settings:JSON.stringify({assistantId:$('assistant').value,selections:Object.fromEntries(selections),disabledAnimations})});
 const loadSettings=raw=>{selections.clear();disabledAnimations={};rememberedAssistant='';try{const value=JSON.parse(raw??'{}');if(typeof value.assistantId==='string')rememberedAssistant=value.assistantId;for(const [id,item] of Object.entries(value.selections??{}).slice(0,100))if(typeof item?.id==='string'&&typeof item?.digest==='string')selections.set(id,{id:item.id,digest:item.digest});for(const [id,off] of Object.entries(value.disabledAnimations??{}).slice(0,200))if(off===true)disabledAnimations[id]=true;}catch{/* Invalid old preferences use safe defaults. */}};
 const animations=item=>{
  $('animation-options').replaceChildren();const clips=animationChoices(item);
  const summary=()=>{$('animation-status').textContent=clips.length?`${clips.filter(x=>!disabledAnimations[animationKey(item,x.clip)]).length} of ${clips.length} animations enabled. Enabled animations play in a shuffled cycle.`:'This appearance has no bundled animations.';};summary();
  for(const {clip,label:name,group} of clips){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.checked=!disabledAnimations[animationKey(item,clip)];input.onchange=run(async()=>{const key=animationKey(item,clip),before=disabledAnimations[key];if(input.checked)delete disabledAnimations[key];else disabledAnimations[key]=true;summary();try{await saveSettings();status('Animation preference saved on this phone.');}catch(error){if(before)disabledAnimations[key]=true;else delete disabledAnimations[key];input.checked=!before;summary();throw error;}});label.append(input,document.createTextNode(group?`${group} · ${name}`:name));$('animation-options').append(label);}
 };
 const status=text=>{$('status').textContent=text;};
 const api=async(path,body)=>{
  const result=await native.request({path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value;try{value=JSON.parse(result.body);}catch{throw Error('Unexpected server response.');}
  if(result.status>=400){const error=Error(value.error?.message??value.message??value.code??'Request unavailable.');error.status=result.status;throw error;}return value;
 };
 const clearDisplay=()=>{epoch++;appearanceLoad?.abort();appearanceLoad=null;renderer?.dispose();renderer=null;const canvas=$('avatar');canvas.replaceWith(canvas.cloneNode(false));$('transcript').replaceChildren();$('intro').hidden=false;};
 const protect=()=>{if(textState.busy)void native.cancelText().catch(()=>{});textGeneration++;textState={};$('text-input').value='';privateAllowed=false;expires=0;clearDisplay();catalog=null;$('animation-options').replaceChildren();$('animation-status').textContent='Only me activates when you open the app, start listening or send a message.';$('appearance').replaceChildren(new Option('Neutral reference','neutral'));for(let i=1;i<$('assistant').options.length;i++)$('assistant').options[i].textContent=`Assistant ${i}`;$('privacy').textContent='Unknown/shared · private context withheld';};
 const controls=()=>{
  const active=!!nativeState.active,busy=!!textState.busy;renderActivity(nativeState,textState);
  $('transcript-hint').textContent=privateAllowed?'Your transcribed speech and Assistant replies appear here.':'Only me activates when you start listening or send a message.';
  $('text-input').disabled=!session||active||starting||restoring||busy;
  $('send-text').disabled=$('text-input').disabled||!$('assistant').value||!$('text-input').value.trim();
  $('connection').querySelector('button').disabled=restoring;
  $('start').disabled=restoring||!session||!$('assistant').value||active||starting||busy;
  $('stop').disabled=!active&&!starting&&!busy;
  for(const id of ['assistant','background'])$(id).disabled=active||starting||busy||!session;
  for(const id of ['appearance','apply-appearance'])$(id).disabled=active||starting||busy||!session||!privateAllowed;
  $('sign-out').hidden=!session;$('session-panel').hidden=!session;
 };
 const run=fn=>async event=>{event?.preventDefault();try{await fn();}catch(error){status(error.message);}finally{controls();}};
 function message(role,text,trace,append=false){
  if(document.hidden||!privateAllowed)return;
  let entry=append?[...$('transcript').children].find(x=>x.dataset.trace===trace&&x.dataset.role===role):null;
  if(!entry){entry=document.createElement('li');entry.dataset.role=role;entry.dataset.trace=trace;entry.append(document.createElement('strong'),document.createElement('p'));entry.firstChild.textContent=role==='user'?'You':'Assistant';$('transcript').append(entry);while($('transcript').children.length>100)$('transcript').firstChild.remove();}
  entry.lastChild.textContent=((append?entry.lastChild.textContent:'')+text).slice(-64000);$('transcript').scrollTop=$('transcript').scrollHeight;
 }
 async function render(item){
  if(!privateAllowed||document.hidden)return;if(item.manifest?.resources?.some(resource=>resource.bytes>64*1024*1024))throw Error('This iOS build supports appearance resources up to 64 MiB each.');const ticket=epoch;
  renderer??=new PresentationRuntime($('avatar'),{playback:()=>nativeState,identity:()=>({assistantId:$('assistant').value,endpointId:context?.endpoint?.endpointId}),onFailure:status,retrieveResource:bundledResource,randomAnimations:true,animationEnabled:clip=>!disabledAnimations[animationKey(renderer?.currentItem??{id:'neutral',digest:'neutral-v1'},clip)]});
  const target=renderer,controller=appearanceLoad=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let value;try{value=await target.prepare(item,controller.signal);}finally{clearTimeout(timer);if(appearanceLoad===controller)appearanceLoad=null;}
  if(ticket!==epoch||!privateAllowed||document.hidden){target.release(value);return}target.currentItem=item;target.commit(value);animations(item);$('intro').hidden=true;
 }
 async function appearances(){
  const ticket=epoch,value=await bundledAppearances();if(ticket!==epoch||!privateAllowed)return;
  catalog=value;$('appearance').replaceChildren();for(const item of [catalog.neutral,...catalog.packages])$('appearance').add(new Option(item.label,item.id));
  const saved=selections.get($('assistant').value);
  const {item,migrated}=resolveAppearance(catalog,saved,disabledAnimations);
  if(migrated){selections.set($('assistant').value,{id:item.id,digest:item.digest});await saveSettings();if(ticket!==epoch||!privateAllowed)return;}
  if(!item){status('Saved appearance is unavailable. Choose an available appearance.');return}
  $('appearance').value=item.id;await render(item);
 }
 async function checkAudience(){
  const ticket=epoch,audienceTicket=audienceGeneration;
  try{
   const audience=await api('/api/runtime/v1/audience');if(ticket!==epoch||audienceTicket!==audienceGeneration)return;
   const expiry=audience.expiresAt?Date.parse(audience.expiresAt):0;
   if(!audienceLeaseId||audience.leaseId!==audienceLeaseId||audience.privateAllowed!==true||!expiry||!Number.isFinite(expiry)||expiry<=Date.now()){const wasPrivate=privateAllowed,owned=audienceLeaseId;audienceLeaseId=null;if(owned)void native.endAudience({leaseId:owned}).catch(()=>{});if(wasPrivate||textState.busy)protect();if(wasPrivate)status('The app audience session ended. Start listening or Send reconnects it, subject to current server permission.');return false}
   privateAllowed=true;expires=expiry;$('privacy').textContent='Only me · personal disclosure active';return true;
  }catch(error){if(ticket===epoch&&audienceTicket===audienceGeneration){protect();status('Personal disclosure could not be checked. '+error.message);}throw error;}
 }
 // Native code owns a process-local, renewable connection lease. The server's
 // short failure-detection window is not a user-facing conversation time limit.
 async function activateOnlyMe(isCurrent){
  audienceGeneration++;declaringAudience++;
  try{let current=await api('/api/runtime/v1/session-context');if(!isCurrent())return null;
  if(current.endpoint?.endpointClass!=='personalCompanion'||current.endpoint?.privacyClass!=='personal'||!current.endpoint?.inputModalities?.includes('audio')){
   current=await api('/api/runtime/v1/session-context',{expectedRevision:current.revision,...(current.endpoint?.endpointClass==='personalCompanion'?{}:{bindingKey:crypto.randomUUID(),endpointClass:'personalCompanion'}),mode:'audio',audienceScope:'authenticatedSession'});
   if(!isCurrent())return null;
  }
  const lease=await native.beginAudience();if(!isCurrent())return null;
  if(typeof lease.leaseId!=='string')throw Error('The private server did not establish this app audience session. Update the server and reconnect.');
  audienceLeaseId=lease.leaseId;context=current;const allowed=await checkAudience();
  if(allowed===false){status('The server is withholding personal disclosure. Check the current audience or account permission before retrying.');return null;}
  if(!isCurrent()||!privateAllowed)return null;
  return current;
  }finally{declaringAudience--;}
 }
 async function refresh(){
  if(!session||refreshing)return;refreshing=true;
  try{
   const identity=session;context=await api('/api/runtime/v1/session-context');await checkAudience();
   const ticket=epoch,result=await api('/api/admin/v1/assistants');if(identity!==session||ticket!==epoch)return;
   const old=$('assistant').value||rememberedAssistant;$('assistant').replaceChildren(new Option('Choose an Assistant',''));
   for(const [i,item] of (result.assistants??[]).entries()){
    const profile=item.profiles?.at(-1);$('assistant').add(new Option(privateAllowed?(profile?.corePersona?.canonicalName??profile?.displayName??profile?.name??`Assistant ${i+1}`):`Assistant ${i+1}`,item.assistantId));
   }
   $('assistant').value=old;if(!$('assistant').value&&$('assistant').options.length===2)$('assistant').selectedIndex=1;
   if(privateAllowed)try{await appearances();}catch(error){$('animation-status').textContent='Appearance unavailable. '+error.message;}
  }finally{refreshing=false;controls();}
 }
 const refreshDisplay=()=>{if(!renderer)void refresh().catch(error=>{$('animation-status').textContent='Appearance unavailable. '+error.message;});};
 async function bindSession(account,ticket){
  if(ticket!==connectionGeneration)return;
  if(!account?.sessionId)throw Error('Server did not return a session.');
  session=account;const audience=await activateOnlyMe(()=>ticket===connectionGeneration);
  if(ticket!==connectionGeneration)return;await refresh();pane(false);if(!audience)return;status('Connected. Only me is active; tap Start to listen or send a message.');
 }
 async function restore(){
  if(restoring)return;
  const ticket=++connectionGeneration;startGeneration++;starting=false;restoring=true;audienceLeaseId=null;protect();session=null;controls();
  try{
   const saved=await native.restoreConnection();if(ticket!==connectionGeneration)return;
   if(saved.endpoint){$('server').value=saved.endpoint;$('username').value=saved.username??'';savedIdentity=JSON.stringify([saved.endpoint,saved.username??'']);loadSettings(saved.settings);}
   $('retry-connection').hidden=!saved.hasSession&&!saved.hasSavedCredentials;
   if(saved.authState==='offline')throw Error('Check your private server and VPN connection.');
   if(saved.authState==='needsOneTimeCode'){pane(true);status('Your previous sign-in used an authenticator code. Sign in with a fresh code if required; otherwise leave it blank.');return;}
   if(!saved.hasSession){status(saved.endpoint?'Saved server and account restored. Sign in once to enable automatic sign-in.':'Connect to your existing private Assistant server in Settings.');return;}
   status('Reconnecting to your saved server…');await bindSession(saved.account??await api('/api/auth/v1/session'),ticket);$('retry-connection').hidden=true;
  }catch(error){if(ticket!==connectionGeneration)return;session=null;protect();if(error.status===401){await native.forgetSession();$('retry-connection').hidden=true;status('Your saved session expired or was revoked. Sign in again in Settings.');}else{status('Saved connection is currently unavailable. Open Settings to reconnect. '+error.message);}}
  finally{if(ticket===connectionGeneration){restoring=false;controls();}}
 }
 $('open-settings').onclick=()=>pane(true);$('close-settings').onclick=()=>pane(false);
 $('retry-connection').onclick=run(restore);
 $('connection').onsubmit=run(async()=>{
  const ticket=++connectionGeneration;restoring=true;startGeneration++;audienceLeaseId=null;protect();session=null;context=null;controls();
  try{
   const endpoint=$('server').value.trim().replace(/\/$/,''),username=$('username').value.trim().toLowerCase(),identity=JSON.stringify([endpoint,username]);
   if(identity!==savedIdentity)loadSettings('{}');savedIdentity=identity;$('assistant').replaceChildren(new Option('Choose an Assistant',''));
   await native.configure({endpoint,username});$('retry-connection').hidden=true;
   let account;try{account=await api('/api/auth/v1/sign-in',{username,password:$('password').value,...($('totp').value?{totp:$('totp').value}:{})});}finally{$('password').value='';$('totp').value='';}
   $('retry-connection').hidden=false;await bindSession(account.session,ticket);$('retry-connection').hidden=true;
  }catch(error){if(ticket===connectionGeneration){session=null;protect();}throw error;}finally{if(ticket===connectionGeneration)restoring=false;}
 });
 $('start').onclick=run(async()=>{
  const ticket=++startGeneration;starting=true;textState={};controls();try{const current=await activateOnlyMe(()=>ticket===startGeneration&&!!session&&!document.hidden);if(!current||ticket!==startGeneration||!privateAllowed||document.hidden)return;
   nativeState=await native.start({request:{sessionId:session.sessionId,expectedSessionRevision:current.revision,endpointId:current.endpoint.endpointId,assistantId:$('assistant').value},background:$('background').checked});status(nativeState.phase??'Connecting native audio…');refreshDisplay();
  }finally{if(ticket===startGeneration)starting=false;}
 });
 $('stop').onclick=run(async()=>{startGeneration++;textGeneration++;textState={};starting=false;nativeState=await native.stop();status('Conversation stopped. Microphone and playback are off.');});
 $('text-input').oninput=controls;
 $('text-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send-text').disabled)$('text-chat').requestSubmit();}};
 $('text-chat').onsubmit=run(async()=>{
  const prompt=$('text-input').value.trim();if(!prompt||textState.busy)return;
  if(!session||!$('assistant').value||nativeState.active||starting||restoring)throw Error('Stop listening and select an Assistant before sending text.');
  const ticket=++textGeneration,trace=crypto.randomUUID(),assistantId=$('assistant').value;
  textState={busy:true};controls();status('Checking the current conversation…');
  try{const current=await activateOnlyMe(()=>ticket===textGeneration&&!!session&&!document.hidden);if(!current||ticket!==textGeneration||!privateAllowed||document.hidden)return;
   message('user',prompt,trace);$('text-input').value='';status('Sending text to your Assistant…');refreshDisplay();
   const result=await native.sendText({assistantId,userInput:prompt,trace});
   if(ticket!==textGeneration||!privateAllowed||document.hidden)return;
   if(result.trace!==trace||typeof result.text!=='string')throw Error('The text response did not match this message.');
   message('assistant',result.text,trace);textState={complete:true};status('Text reply received. Microphone remains off.');
  }catch(error){if(ticket!==textGeneration)return;textState={error:true};throw error;}
  finally{if(ticket===textGeneration){textState.busy=false;controls();}}
 });
 $('background').onchange=run(()=>native.setBackgroundPolicy({enabled:$('background').checked}));
 $('routes').onclick=run(()=>native.routePicker());
 $('refresh').onclick=run(refresh);
 $('assistant').onchange=run(async()=>{rememberedAssistant=$('assistant').value;await saveSettings();clearDisplay();if(privateAllowed)await appearances();});
 $('apply-appearance').onclick=run(async()=>{
  if(nativeState.active||starting||!privateAllowed)throw Error('Stop listening and review your audience before changing appearance.');
  const item=[catalog.neutral,...catalog.packages].find(x=>x.id===$('appearance').value);if(!item)throw Error('Choose an available appearance.');
  if(!renderer)throw Error('Refresh the display before applying an appearance.');if(item.manifest?.resources?.some(resource=>resource.bytes>64*1024*1024))throw Error('This iOS build supports appearance resources up to 64 MiB each.');
  const target=renderer,ticket=epoch,controller=appearanceLoad=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let candidate;
  try{
   candidate=await target.prepare(item,controller.signal);controller.signal.throwIfAborted();
   if(ticket!==epoch||!privateAllowed||nativeState.active||starting)throw Error('The conversation changed while loading.');
   if(ticket!==epoch||!privateAllowed||document.hidden)throw Error('The audience changed while loading.');
   selections.set($('assistant').value,{id:item.id,digest:item.digest});await saveSettings();if(ticket!==epoch||!privateAllowed||document.hidden)throw Error('The audience changed while saving.');target.currentItem=item;target.commit(candidate);animations(item);candidate=null;$('intro').hidden=true;status('Appearance applied and saved on this phone.');
  }finally{if(candidate)target.release(candidate);clearTimeout(timer);if(appearanceLoad===controller)appearanceLoad=null;}
 });
 $('sign-out').onclick=run(async()=>{
  connectionGeneration++;startGeneration++;starting=false;audienceLeaseId=null;protect();await native.stop();let remoteFailed=false;try{await api('/api/auth/v1/sign-out',{});}catch{remoteFailed=true;}finally{session=null;nativeState={};$('retry-connection').hidden=true;await native.forgetSession();pane(true);status(remoteFailed?'Signed out on this phone. The server was unavailable; its session could not be revoked.':'Signed out. Server and account details are remembered.');}
 });
 void native.addListener('event',event=>{
  if(event.type==='audience'&&!event.active){audienceLeaseId=null;startGeneration++;starting=false;protect();status(event.reason??'The app audience session ended.');controls();}
  else if(event.type==='state'){
   nativeState=event.state;$('route').textContent=event.state.route||'System route';if(!textState.busy)status(event.state.phase);
   renderer?.applyState(event.state.playing?'speaking':event.state.active?'listening':'idle');
   if(/audience|authorization|sign-in/i.test(event.state.phase)){protect();if(/audience/i.test(event.state.phase))status(event.state.phase+' Start listening or Send activates Only me again, subject to current server permission.');}controls();
  }else if(event.type==='transcript')message('user',event.text,event.trace);else if(event.type==='textDelta')message('assistant',event.text,event.trace,true);
 });
 const privacyTimer=setInterval(()=>{
  if(document.hidden||!session||starting||restoring||declaringAudience)return;
  if(expires&&expires<=Date.now()){protect();status('The app audience connection ended. Start listening or Send reconnects it.');controls();}
  if(!refreshing)void checkAudience().then(controls).catch(()=>controls());
 },1000);
 const resume=async()=>{protect();nativeState=await native.snapshot();controls();if(nativeState.active){if(session)await refresh();}else await restore();};
 document.addEventListener('lifestream-native-resume',()=>{void resume().catch(error=>status(error.message));});
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden){protect();}
  else void resume().catch(error=>status(error.message));
 });
 window.addEventListener('pagehide',()=>{protect();clearInterval(privacyTimer);});
 controls();status('Restoring saved connection…');void restore();
 return {refresh,api,get state(){return {session,privateAllowed,nativeState}}};
}
