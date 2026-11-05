import {createMobileHistory} from './conversation-history.js';
import {bundledAppearances,bundledResource} from './bundled-appearances.js';
import {animationKey,animationChoices,adapterAnimationChoices,resolveAppearance} from './animation-preferences.js';
import {renderActivity} from './activity.js';
import {assertMobilePresentation} from './presentation-limits.js';
import {MobilePresentationRuntime} from './mobile-presentation-runtime.js';
import {createVoiceSettings} from './voice-settings.js';

// The view owns no microphone, PCM queue, credential storage or background worker.
export function installApp(native) {
 const $=id=>document.getElementById(id);
 let diagnosticEnabled=false,lastCameraDiagnostic=0;
 const log=event=>{if(diagnosticEnabled&&typeof native.logDiagnostic==='function')void native.logDiagnostic({event}).catch(()=>{});};
 const cameraLog=()=>{if(!diagnosticEnabled)return;const now=performance.now();if(now-lastCameraDiagnostic>=1000){lastCameraDiagnostic=now;log('camera_changed');}};
 let session=null,context=null,catalog=null,renderer=null,nativeState={},epoch=0,privateAllowed=false,starting=false,refreshing=false,expires=0,startGeneration=0,appearanceLoad=null,history=null,historyBusy=false,historyCursor=null,historyConversation=null;
 let newChat=true,needsChatResolution=false,chatsLoaded=false;
 const selections=new Map();let disabledAnimations={},physicsPreferences={},rememberedAssistant='',connectionGeneration=0,restoring=false,savedIdentity='',textGeneration=0,textState={},audienceGeneration=0,declaringAudience=0,audienceLeaseId=null,probeActive=false,probeGeneration=0,probeMode='media';
 const pane=settings=>{if(settings)log('settings_opened');$(settings?'status-settings':'status-home').append($('status'));$('settings-pane').hidden=!settings;$('main-pane').hidden=settings;$('open-settings').hidden=settings;$('open-settings').setAttribute('aria-expanded',String(settings));if(settings)$('settings-title').focus();window.scrollTo({top:0,behavior:'instant'});};
 const saveSettings=()=>native.saveSettings({settings:JSON.stringify({assistantId:$('assistant').value,selections:Object.fromEntries(selections),disabledAnimations,physicsPreferences})}).then(value=>{log('settings_saved');return value;},error=>{log('settings_failed');throw error;});
 const loadSettings=raw=>{selections.clear();disabledAnimations={};physicsPreferences={};rememberedAssistant='';try{const value=JSON.parse(raw??'{}');if(typeof value.assistantId==='string')rememberedAssistant=value.assistantId;for(const [id,item] of Object.entries(value.selections??{}).slice(0,100))if(typeof item?.id==='string'&&typeof item?.digest==='string')selections.set(id,{id:item.id,digest:item.digest});for(const [id,off] of Object.entries(value.disabledAnimations??{}).slice(0,200))if(off===true)disabledAnimations[id]=true;for(const [key,p] of Object.entries(value.physicsPreferences??{}).slice(0,100))if(p&&['hair','soft','collision'].every(k=>typeof p[k]==='boolean'))physicsPreferences[key]={hair:p.hair,soft:p.soft,collision:p.collision};}catch{/* Invalid old preferences use safe defaults. */}};
 const animations=item=>{
  $('animation-options').replaceChildren();$('animation-selector-controls').hidden=true;$('animation-selector').replaceChildren();
  if(item.manifest?.schemaVersion==='1.5.0'&&renderer?.current?.adapter){
   const clips=adapterAnimationChoices(item);for(const clip of clips)$('animation-selector').add(new Option(clip.clipName,clip.sourceAnimationId));
   $('animation-selector-controls').hidden=!clips.length;$('animation-status').textContent=clips.length?'Choose a supported animation or resume the automatic cycle.':'No selectable animations are available for this appearance.';controls();return;
  }const clips=animationChoices(item);
  const summary=()=>{$('animation-status').textContent=clips.length?`${clips.filter(x=>!disabledAnimations[animationKey(item,x.clip)]).length} of ${clips.length} animations enabled. Enabled animations play in a shuffled cycle.`:'This appearance has no bundled animations.';};summary();
  for(const {clip,label:name,group} of clips){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.checked=!disabledAnimations[animationKey(item,clip)];input.onchange=run(async()=>{const key=animationKey(item,clip),before=disabledAnimations[key];if(input.checked)delete disabledAnimations[key];else disabledAnimations[key]=true;summary();try{await saveSettings();status('Animation preference saved on this phone.');}catch(error){if(before)disabledAnimations[key]=true;else delete disabledAnimations[key];input.checked=!before;summary();throw error;}});label.append(input,document.createTextNode(group?`${group} · ${name}`:name));$('animation-options').append(label);}
 };
 const physicsKey=item=>JSON.stringify([item?.id,item?.digest]);
 const physicsSettings=value=>({hair:value.hair,soft:value.soft,collision:value.collision,hairIntensity:1,softIntensity:1,collisionIntensity:1});
 function updatePhysics(item){
  const supported=!!renderer?.current?.adapter&&item?.manifest?.schemaVersion==='1.5.0'&&!!item.manifest.physics;
  $('physics-options').hidden=!supported;$('physics-status').textContent=supported?'Supported visual physics are enabled for this appearance.':'This appearance has no supported physics profile.';
  if(!supported)return;const values=physicsPreferences[physicsKey(item)]??{hair:true,soft:true,collision:true};for(const key of ['hair','soft','collision'])$('physics-'+key).checked=values[key];
  if(!renderer.setPhysicsSettings(physicsSettings(values)))throw Error('Physics could not be applied.');
 }
 for(const key of ['hair','soft','collision'])$('physics-'+key).onchange=runPhysics;
 async function runPhysics(){if(!renderer?.current?.adapter||!privateAllowed)return;log('physics_changed');const target=renderer,ticket=epoch,item=target.currentItem,values=Object.fromEntries(['hair','soft','collision'].map(k=>[k,$('physics-'+k).checked])),key=physicsKey(item),before=physicsPreferences[key];try{if(!target.setPhysicsSettings(physicsSettings(values)))throw Error('Physics could not be applied.');physicsPreferences[key]=values;await saveSettings();if(target===renderer&&ticket===epoch&&privateAllowed)$('physics-status').textContent='Visual physics settings saved on this phone.';}catch(error){if(before)physicsPreferences[key]=before;else delete physicsPreferences[key];if(target===renderer&&ticket===epoch&&privateAllowed){updatePhysics(item);status(error.message);}}}
 const status=text=>{$('status').textContent=text;};
 const api=async(path,body)=>{
  const result=await native.request({path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value;try{value=JSON.parse(result.body);}catch{throw Error('Unexpected server response.');}
  if(result.status>=400){const error=Error(value.error?.message??value.message??value.code??'Request unavailable.');error.status=result.status;throw error;}return value;
 };
 const voiceSettings=createVoiceSettings({native,api,owner:()=>session&&privateAllowed&&!document.hidden&&!$('settings-pane').hidden&&!nativeState.active&&!starting&&!textState.busy?{session,epoch,assistantId:$('assistant').value}:null,current:job=>!!session&&job.session===session&&job.epoch===epoch&&privateAllowed&&!document.hidden&&!$('settings-pane').hidden&&job.assistantId===$('assistant').value&&!nativeState.active&&!starting&&!textState.busy,view:{load:$('voice-load'),message:$('voice-message'),reference:$('voice-reference'),referencePreview:$('voice-reference-preview'),delivery:$('voice-delivery'),pace:$('voice-pace'),energy:$('voice-energy'),label:$('voice-label'),save:$('voice-save'),reset:$('voice-reset'),draftPreview:$('voice-draft-preview'),savedPreview:$('voice-saved-preview'),stop:$('voice-stop'),candidates:$('voice-candidates'),review:$('voice-review'),activate:$('voice-activate')}});
 const clearDisplay=()=>{epoch++;appearanceLoad?.abort();appearanceLoad=null;renderer?.dispose();renderer=null;const canvas=$('avatar');canvas.replaceWith(canvas.cloneNode(false));$('transcript').replaceChildren();$('intro').hidden=false;};
 const protect=()=>{voiceSettings.invalidate();log('privacy_protected');history?.invalidate();historyBusy=false;historyCursor=null;historyConversation=null;newChat=true;chatsLoaded=false;$('history-list').replaceChildren(new Option('[New voice chat]',''));$('history-older').hidden=true;$('history-status').textContent='';if(textState.busy)void native.cancelText().catch(()=>{});textGeneration++;textState={};$('text-input').value='';privateAllowed=false;expires=0;clearDisplay();catalog=null;$('animation-options').replaceChildren();$('physics-options').hidden=true;$('animation-selector-controls').hidden=true;$('animation-selector').replaceChildren();$('physics-status').textContent='Available for appearances with a supported physics profile.';$('animation-status').textContent='Only me activates when you open the app, start listening or send a message.';$('appearance').replaceChildren(new Option('Neutral reference','neutral'));for(let i=1;i<$('assistant').options.length;i++)$('assistant').options[i].textContent=`Assistant ${i}`;$('privacy').textContent='Unknown/shared · private context withheld';};
 const controls=()=>{
  const active=!!nativeState.active,busy=!!textState.busy,historyUnavailable=historyBusy||!!history?.isPending()||needsChatResolution;renderActivity(nativeState,textState);
  $('history-list').disabled=!session||active||starting||busy||restoring||historyBusy;$('history-older').disabled=!privateAllowed||active||starting||busy||historyBusy||!historyCursor;$('history-older').hidden=!historyCursor;
  if(history?.isPending())$('history-status').textContent='The last change is unconfirmed. Open the chat selector to check it.';
  if(probeActive){$('input-status').textContent=probeMode==='conversation'?'Test mic (no capture)':'Off';$('input-light').dataset.state=probeMode==='conversation'?'ready':'off';$('output-status').textContent='Local audio test';$('output-light').dataset.state='playing';$('audio-detail').textContent='Local test follows the system audio route. Microphone samples are never read, saved or sent.';}
  $('text-input').disabled=!session||active||starting||restoring||busy||historyUnavailable;
  $('send-text').disabled=$('text-input').disabled||!$('assistant').value||!$('text-input').value.trim();
  $('connection').querySelector('button').disabled=restoring;
  for(const id of ['view-zoom-in','view-zoom-out','view-reset'])$(id).disabled=!renderer||!privateAllowed;
  for(const id of ['physics-hair','physics-soft','physics-collision'])$(id).disabled=!renderer?.current?.adapter||!privateAllowed;
  for(const id of ['animation-selector','animation-play','animation-auto'])$(id).disabled=!renderer?.current?.adapter||!privateAllowed||!!nativeState.playing;
  $('start').disabled=restoring||!session||!$('assistant').value||active||starting||busy||historyUnavailable;
  $('stop').disabled=!active&&!starting&&!busy&&!probeActive;
  $('start').hidden=active||starting||busy||probeActive;$('stop').hidden=!$('start').hidden;
  $('probe-stop').disabled=!probeActive;for(const id of ['probe-media','probe-conversation'])$(id).disabled=restoring;
  for(const id of ['assistant','background'])$(id).disabled=active||starting||busy||!session;
  for(const id of ['appearance','apply-appearance'])$(id).disabled=active||starting||busy||!session||!privateAllowed;
  $('sign-out').hidden=!session;$('session-panel').hidden=!session;$('session-privacy').hidden=!session;
 };
 const run=fn=>async event=>{event?.preventDefault();try{await fn();}catch(error){status(error.message);}finally{controls();}};
 function message(role,text,trace,append=false){
  if(document.hidden||!privateAllowed)return;
  let entry=append?[...$('transcript').children].find(x=>x.dataset.trace===trace&&x.dataset.role===role):null;
  if(!entry){entry=document.createElement('li');entry.dataset.role=role;entry.dataset.trace=trace;entry.append(document.createElement('strong'),document.createElement('p'));entry.firstChild.textContent=role==='user'?'You':'Assistant';$('transcript').append(entry);while($('transcript').children.length>100)$('transcript').firstChild.remove();}
  entry.lastChild.textContent=((append?entry.lastChild.textContent:'')+text).slice(-64000);$('transcript').scrollTop=$('transcript').scrollHeight;
 }
 async function render(item){
  if(!privateAllowed||document.hidden)return;assertMobilePresentation(item);const ticket=epoch;
  log('avatar_load');renderer??=new MobilePresentationRuntime($('avatar'),{onViewChanged:cameraLog,onViewReset:()=>log('camera_reset'),playback:()=>nativeState,identity:()=>({assistantId:$('assistant').value,endpointId:context?.endpoint?.endpointId}),onFailure:status,retrieveResource:bundledResource,randomAnimations:true,animationEnabled:clip=>!disabledAnimations[animationKey(renderer?.currentItem??{id:'neutral',digest:'neutral-v1'},clip)]});
  const target=renderer,controller=appearanceLoad=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let value;try{value=await target.prepare(item,controller.signal);}catch(error){log('avatar_failed');throw error;}finally{clearTimeout(timer);if(appearanceLoad===controller)appearanceLoad=null;}
  if(ticket!==epoch||!privateAllowed||document.hidden){target.release(value);return}target.currentItem=item;target.commit(value);animations(item);updatePhysics(item);log('avatar_ready');$('intro').hidden=true;
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
  if(ticket!==connectionGeneration)return;await refresh();pane(false);if(!audience)return;await loadChats();log('connection_restore_done');status('Connected. Only me is active; tap Start to listen or send a message.');
 }
 async function restore(){
  if(restoring)return;log('connection_restore_start');
  const ticket=++connectionGeneration;startGeneration++;starting=false;restoring=true;audienceLeaseId=null;protect();session=null;controls();
  try{
   const saved=await native.restoreConnection();if(ticket!==connectionGeneration)return;
   if(saved.endpoint){$('server').value=saved.endpoint;$('username').value=saved.username??'';savedIdentity=JSON.stringify([saved.endpoint,saved.username??'']);loadSettings(saved.settings);}
   $('retry-connection').hidden=!saved.hasSession&&!saved.hasSavedCredentials;
   if(saved.authState==='offline')throw Error('Check your private server and VPN connection.');
   if(saved.authState==='needsOneTimeCode'){pane(true);status('Your previous sign-in used an authenticator code. Sign in with a fresh code if required; otherwise leave it blank.');return;}
   if(!saved.hasSession){status(saved.endpoint?'Saved server and account restored. Sign in once to enable automatic sign-in.':'Connect to your existing private Assistant server in Settings.');return;}
   status('Reconnecting to your saved server…');await bindSession(saved.account??await api('/api/auth/v1/session'),ticket);$('retry-connection').hidden=true;
  }catch(error){if(ticket!==connectionGeneration)return;log('connection_restore_failed');session=null;protect();if(error.status===401){await native.forgetSession();$('retry-connection').hidden=true;status('Your saved session expired or was revoked. Sign in again in Settings.');}else{status('Saved connection is currently unavailable. Open Settings to reconnect. '+error.message);}}
  finally{if(ticket===connectionGeneration){restoring=false;controls();}}
 }
 const diagnosticStatus=async()=>{if(typeof native.diagnosticsStatus!=='function'){$('verbose-diagnostics').disabled=true;$('share-diagnostics').disabled=true;$('clear-diagnostics').disabled=true;return;}const value=await native.diagnosticsStatus();diagnosticEnabled=value.enabled===true;$('verbose-diagnostics').checked=diagnosticEnabled;$('verbose-diagnostics-status').textContent=value.storageError?'Diagnostics storage is unavailable on this phone.':`${diagnosticEnabled?'Diagnostics are on':'Diagnostics are off'} · ${Number.isSafeInteger(value.count)?value.count:0} events stored.`;};
 $('verbose-diagnostics').onchange=run(async()=>{const value=await native.setDiagnosticsEnabled({enabled:$('verbose-diagnostics').checked});diagnosticEnabled=value.enabled===true;await diagnosticStatus();});
 $('share-diagnostics').onclick=run(async()=>{const result=await native.shareDiagnostics();$('verbose-diagnostics-status').textContent=result.shared?'Share completed.':'Share cancelled.';});
 $('clear-diagnostics').onclick=run(async()=>{await native.clearDiagnostics();await diagnosticStatus();});
 void diagnosticStatus().catch(()=>{$('verbose-diagnostics-status').textContent='Diagnostics are unavailable.';});
 $('open-settings').onclick=run(async()=>{if(probeActive)await native.stopAudioProbe();pane(true);});$('close-settings').onclick=run(async()=>{voiceSettings.invalidate();if(probeActive)await native.stopAudioProbe();pane(false);});
 $('retry-connection').onclick=run(restore);
 $('connection').onsubmit=run(async()=>{
  log('sign_in_start');const ticket=++connectionGeneration;restoring=true;startGeneration++;audienceLeaseId=null;protect();session=null;context=null;controls();
  try{
   const endpoint=$('server').value.trim().replace(/\/$/,''),username=$('username').value.trim().toLowerCase(),identity=JSON.stringify([endpoint,username]);
   if(identity!==savedIdentity)loadSettings('{}');savedIdentity=identity;$('assistant').replaceChildren(new Option('Choose an Assistant',''));
   await native.configure({endpoint,username});$('retry-connection').hidden=true;
   let account;try{account=await api('/api/auth/v1/sign-in',{username,password:$('password').value,...($('totp').value?{totp:$('totp').value}:{})});}finally{$('password').value='';$('totp').value='';}
   $('retry-connection').hidden=false;await bindSession(account.session,ticket);log('sign_in_done');$('retry-connection').hidden=true;
  }catch(error){log('sign_in_failed');if(ticket===connectionGeneration){session=null;protect();}throw error;}finally{if(ticket===connectionGeneration)restoring=false;}
 });
 $('start').onclick=run(async()=>{
  const ticket=++startGeneration;starting=true;textState={};controls();try{let current=await activateOnlyMe(()=>ticket===startGeneration&&!!session&&!document.hidden);if(!current||ticket!==startGeneration||!privateAllowed||document.hidden)return;current=await ensureChat(()=>ticket===startGeneration&&!!session&&!document.hidden);if(!current||ticket!==startGeneration)return;
   nativeState=await native.start({request:{sessionId:session.sessionId,expectedSessionRevision:current.revision,endpointId:current.endpoint.endpointId,assistantId:$('assistant').value},background:$('background').checked});status(nativeState.phase??'Connecting native audio…');refreshDisplay();
  }finally{if(ticket===startGeneration)starting=false;}
 });
 $('stop').onclick=run(async()=>{startGeneration++;textGeneration++;textState={};starting=false;nativeState=await native.stop();chatsLoaded=false;status('Conversation stopped. Microphone and playback are off.');});
 const localProbe=mode=>run(async()=>{
  const ticket=++probeGeneration;startGeneration++;textGeneration++;starting=false;textState={};probeActive=true;probeMode=mode;controls();
  $('probe-status').textContent='Stopping the conversation for a local audio test…';
  try{await native.startAudioProbe({mode});}catch(error){if(ticket===probeGeneration){probeActive=false;$('probe-status').textContent=error.message;}throw error;}
 });
 $('probe-media').onclick=localProbe('media');$('probe-conversation').onclick=localProbe('conversation');
 $('probe-stop').onclick=run(async()=>{probeGeneration++;await native.stopAudioProbe();probeActive=false;});
 $('copy-audio-diagnostics').onclick=run(async()=>{try{await native.copyAudioDiagnostics();$('diagnostics-copy-status').textContent='Diagnostics copied on this phone. Clipboard copy expires in 5 minutes.';}catch(error){$('diagnostics-copy-status').textContent=error.message;throw error;}});
 history=createMobileHistory({api,owner:()=>session&&privateAllowed&&!document.hidden?{session,principalId:session.principalId,assistantId:$('assistant').value,epoch}:null,current:value=>session===value.session&&privateAllowed&&!document.hidden&&epoch===value.epoch&&$('assistant').value===value.assistantId,afterSelect:async()=>{const ticket=epoch,identity=session;const ready=await activateOnlyMe(()=>ticket===epoch&&identity===session&&!document.hidden);if(!ready)throw Error('The selected conversation could not restore its private audience.');}});
 const showHistory=result=>{historyCursor=result.cursor;historyConversation=result.selected?.conversationId??null;$('transcript').replaceChildren();for(const entry of result.entries){const label=entry.speaker==='assistant'?'assistant':'user';const text=entry.content.state==='retained'?entry.content.text:'[Message unavailable under current history settings]';message(label,text,entry.entryId);}$('history-status').textContent='';controls();};
 async function loadChats(){
  if(!session||historyBusy||nativeState.active||starting||textState.busy)return;const identity=session;historyBusy=true;declaringAudience++;controls();
  try{let reconciledSelection=null;if(!privateAllowed){const ready=await activateOnlyMe(()=>session===identity&&!document.hidden);if(!ready)return;}if(history.isPending()){const state=await history.view();if(state.reconciliation==='created'){needsChatResolution=true;$('history-status').textContent='A previous chat was created. Select a chat before continuing.';}else if(state.reconciliation==='pending'){needsChatResolution=true;$('history-status').textContent='The previous change is still unconfirmed.';}else if(state.reconciliation==='selected'){needsChatResolution=false;newChat=false;showHistory(state);reconciledSelection=state.selected?.conversationId??null;}else if(state.reconciliation){needsChatResolution=false;$('history-status').textContent='The previous change was not applied.';}}
   const ticket=epoch,list=await history.listAll();if(session!==identity||ticket!==epoch||!privateAllowed)return;const current=reconciledSelection??$('history-list').value;$('history-list').replaceChildren(new Option('[New voice chat]',''));for(const item of list)$('history-list').add(new Option(item.title+(item.archived?' (archived)':''),item.conversationId));$('history-list').value=newChat?'':current;chatsLoaded=true;
  }catch(error){$('history-status').textContent='Chats could not be loaded. Open the selector to retry.';}finally{declaringAudience--;historyBusy=false;controls();}
 }
 async function ensureChat(isCurrent){
  if(history.isPending()||needsChatResolution)throw Error('Confirm the previous chat change before continuing.');
  if(!newChat)return await api('/api/runtime/v1/session-context');
  historyBusy=true;declaringAudience++;log('history_create');controls();try{const result=await history.create('New chat');if(!isCurrent()){needsChatResolution=true;chatsLoaded=false;throw Error('The chat was created after the request stopped. Select a chat before continuing.');}newChat=false;needsChatResolution=false;showHistory(result);const selected=result.selected;if(selected){$('history-list').add(new Option(selected.title,selected.conversationId));$('history-list').value=selected.conversationId;}log('history_create_done');return await api('/api/runtime/v1/session-context');}catch(error){log('history_create_failed');throw error;}finally{declaringAudience--;historyBusy=false;controls();}
 }
 $('history-list').onfocus=()=>{if((!chatsLoaded||history.isPending()||!privateAllowed)&&!historyBusy&&!nativeState.active&&!starting&&!textState.busy)void loadChats();};
 $('history-list').onchange=run(async()=>{const id=$('history-list').value;if(!id){if(needsChatResolution||history.isPending())throw Error('Select a chat to resolve the previous change.');newChat=true;historyCursor=null;historyConversation=null;$('transcript').replaceChildren();$('history-status').textContent='';controls();return;}if(!privateAllowed)throw Error('Open the selector to restore a private session.');historyBusy=true;declaringAudience++;controls();try{const result=await history.select(id);newChat=false;needsChatResolution=false;showHistory(result);}catch(error){$('history-status').textContent='Chat selection could not be confirmed. Open the selector to check it.';throw error;}finally{declaringAudience--;historyBusy=false;controls();}});
 $('history-older').onclick=run(async()=>{if(!historyCursor||!historyConversation||historyBusy)return;historyBusy=true;controls();try{const page=await history.older(historyConversation,historyCursor);historyCursor=page.cursor;$('transcript').replaceChildren();for(const entry of page.entries)message(entry.speaker==='assistant'?'assistant':'user',entry.content.state==='retained'?entry.content.text:'[Message unavailable under current history settings]',entry.entryId);$('history-status').textContent='';}finally{historyBusy=false;controls();}});
 $('animation-play').onclick=run(async()=>{log('animation_selected');if(!renderer?.motionAction('clip',$('animation-selector').value))throw Error('Animation is unavailable while speech is playing.');$('animation-status').textContent='Selected animation playing.';});
 $('animation-auto').onclick=run(async()=>{log('animation_automatic');if(!renderer?.motionAction('cycle'))throw Error('Automatic animation is unavailable while speech is playing.');$('animation-status').textContent='Automatic animation resumed.';});
 $('view-zoom-in').onclick=()=>renderer?.adjustView({zoom:1/1.12});$('view-zoom-out').onclick=()=>renderer?.adjustView({zoom:1.12});$('view-reset').onclick=()=>renderer?.resetView();
 $('text-input').oninput=controls;
 $('text-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send-text').disabled)$('text-chat').requestSubmit();}};
 $('text-chat').onsubmit=run(async()=>{
  const prompt=$('text-input').value.trim();if(!prompt||textState.busy)return;
  if(!session||!$('assistant').value||nativeState.active||starting||restoring)throw Error('Stop listening and select an Assistant before sending text.');
  const ticket=++textGeneration,trace=crypto.randomUUID(),assistantId=$('assistant').value,owner=session;
  textState={busy:true};controls();status('Checking the current conversation…');
  try{const current=await activateOnlyMe(()=>ticket===textGeneration&&!!session&&!document.hidden);if(!current||ticket!==textGeneration||!privateAllowed||document.hidden)return;await ensureChat(()=>ticket===textGeneration&&!!session&&!document.hidden);if(ticket!==textGeneration||!privateAllowed||document.hidden)return;
   message('user',prompt,trace);$('text-input').value='';status('Sending text to your Assistant…');refreshDisplay();
   const result=await native.sendText({assistantId,userInput:prompt,trace});
   if(ticket!==textGeneration||!privateAllowed||document.hidden)return;
   if(result.trace!==trace||typeof result.text!=='string')throw Error('The text response did not match this message.');
   message('assistant',result.text,trace);textState={complete:true};chatsLoaded=false;status('Text reply received. Microphone remains off.');
  }catch(error){if(ticket!==textGeneration)return;
   // Only the native client's recognized pre-inference rejection is safe to
   // return to the draft. Unknown failures may already have been admitted.
   if(error.code==='runtime_context_changed'&&session===owner&&privateAllowed&&!document.hidden&&$('assistant').value===assistantId&&!$('text-input').value){
    $('text-input').value=prompt;
    [...$('transcript').children].find(entry=>entry.dataset.role==='user'&&entry.dataset.trace===trace)?.remove();
   }
   textState={error:true};throw error;}
  finally{if(ticket===textGeneration){textState.busy=false;controls();}}
 });
 $('background').onchange=run(()=>native.setBackgroundPolicy({enabled:$('background').checked}));
 $('routes').onclick=run(()=>native.routePicker());
 $('refresh').onclick=run(refresh);
 $('assistant').onchange=run(async()=>{voiceSettings.invalidate();history.invalidate();historyCursor=null;historyConversation=null;newChat=true;chatsLoaded=false;$('history-list').replaceChildren(new Option('[New voice chat]',''));rememberedAssistant=$('assistant').value;await saveSettings();clearDisplay();if(privateAllowed){await appearances();await loadChats();}});
 $('apply-appearance').onclick=run(async()=>{
  log('avatar_load');if(nativeState.active||starting||!privateAllowed)throw Error('Stop listening and review your audience before changing appearance.');
  const item=[catalog.neutral,...catalog.packages].find(x=>x.id===$('appearance').value);if(!item)throw Error('Choose an available appearance.');
  if(!renderer)throw Error('Refresh the display before applying an appearance.');assertMobilePresentation(item);
  const target=renderer,ticket=epoch,controller=appearanceLoad=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let candidate;
  try{
   candidate=await target.prepare(item,controller.signal);controller.signal.throwIfAborted();
   if(ticket!==epoch||!privateAllowed||nativeState.active||starting)throw Error('The conversation changed while loading.');
   if(ticket!==epoch||!privateAllowed||document.hidden)throw Error('The audience changed while loading.');
   selections.set($('assistant').value,{id:item.id,digest:item.digest});await saveSettings();if(ticket!==epoch||!privateAllowed||document.hidden)throw Error('The audience changed while saving.');target.currentItem=item;target.commit(candidate);candidate=null;animations(item);updatePhysics(item);log('avatar_ready');$('intro').hidden=true;status('Appearance applied and saved on this phone.');
  }catch(error){log('avatar_failed');throw error;}finally{if(candidate)target.release(candidate);clearTimeout(timer);if(appearanceLoad===controller)appearanceLoad=null;}
 });
 $('sign-out').onclick=run(async()=>{
  log('sign_out');connectionGeneration++;startGeneration++;starting=false;audienceLeaseId=null;protect();await native.stop();let remoteFailed=false;try{await api('/api/auth/v1/sign-out',{});}catch{remoteFailed=true;}finally{session=null;nativeState={};$('retry-connection').hidden=true;await native.forgetSession();pane(true);status(remoteFailed?'Signed out on this phone. The server was unavailable; its session could not be revoked.':'Signed out. Server and account details are remembered.');}
 });
 void native.addListener('event',event=>{
  if(event.type==='audioProbe'){probeActive=event.active===true;if(event.mode==='media'||event.mode==='conversation')probeMode=event.mode;$('probe-status').textContent=String(event.status??'').slice(0,500);$('probe-detail').textContent=String(event.diagnostics??'').slice(0,2000);$('probe-detail').hidden=!$('probe-detail').textContent;controls();}
  else if(event.type==='audience'&&!event.active){audienceLeaseId=null;startGeneration++;starting=false;protect();status(event.reason??'The app audience session ended.');controls();}
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
  if(document.hidden){probeGeneration++;probeActive=false;void native.stopAudioProbe?.().catch(()=>{});protect();}
  else void resume().catch(error=>status(error.message));
 });
 window.addEventListener('pagehide',()=>{probeGeneration++;probeActive=false;void native.stopAudioProbe?.().catch(()=>{});protect();clearInterval(privacyTimer);});
 controls();status('Restoring saved connection…');void restore();
 return {refresh,api,get state(){return {session,privateAllowed,nativeState}}};
}
