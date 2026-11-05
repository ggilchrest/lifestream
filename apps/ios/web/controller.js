import {shareOptionalCapture} from './optional-capture-share.js';
import {createMobileHistory} from './conversation-history.js';
import {appendConversationMessage,trackConversationViewport} from './conversation-render.js';
import {bundledAppearances,bundledResource} from './bundled-appearances.js';
import {animationKey,animationChoices,adapterAnimationChoices,resolveAppearance} from './animation-preferences.js';
import {renderActivity} from './activity.js';
import {assertMobilePresentation} from './presentation-limits.js';
import {MobilePresentationRuntime} from './mobile-presentation-runtime.js';
import {createVoiceSettings} from './voice-settings.js';
import {createHealthInventoryView} from './health-inventory-view.js';
import {createCalendarReconnectView} from './calendar-reconnect-view.js';

// The view owns no microphone, PCM queue, credential storage or background worker.
export function installApp(native) {
 const $=id=>document.getElementById(id);
 let diagnosticEnabled=false,lastCameraDiagnostic=0;
 const log=event=>{if(diagnosticEnabled&&typeof native.logDiagnostic==='function')void native.logDiagnostic({event}).catch(()=>{});};
 const cameraLog=()=>{if(!diagnosticEnabled)return;const now=performance.now();if(now-lastCameraDiagnostic>=1000){lastCameraDiagnostic=now;log('camera_changed');}};
 let session=null,context=null,catalog=null,renderer=null,nativeState={},epoch=0,privateAllowed=false,starting=false,refreshing=false,expires=0,startGeneration=0,appearanceLoad=null,history=null,historyBusy=false,historyCursor=null,historyConversation=null;
 let newChat=true,needsChatResolution=false,chatsLoaded=false;
 let personalGeneration=0,personalSnapshot=null,userLocked=false,pendingLock=null,pendingLockBody=null,unresolvedElsewhere=false,personalAppConfirmed=false;
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
  const result=await native.request({path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  let value;try{value=JSON.parse(result.body);}catch{throw Error('Unexpected server response.');}
  if(result.status>=400){const error=Error(value.error?.message??value.message??value.code??'Request unavailable.');error.status=result.status;const code=value.code??value.error?.code;if(['history_selection_busy','personal_session_reauthentication_required'].includes(code))error.code=code;throw error;}return value;
 };
 const voiceSettings=createVoiceSettings({native,api,owner:()=>session&&privateAllowed&&!document.hidden&&!$('settings-pane').hidden&&!nativeState.active&&!starting&&!textState.busy?{session,epoch,assistantId:$('assistant').value}:null,current:job=>!!session&&job.session===session&&job.epoch===epoch&&privateAllowed&&!document.hidden&&!$('settings-pane').hidden&&job.assistantId===$('assistant').value&&!nativeState.active&&!starting&&!textState.busy,view:{load:$('voice-load'),message:$('voice-message'),reference:$('voice-reference'),referencePreview:$('voice-reference-preview'),previewText:$('voice-preview-text'),seed:$('voice-seed'),seedHint:$('voice-seed-hint'),conditioning:$('voice-conditioning'),selected:$('voice-selected'),delivery:$('voice-delivery'),pace:$('voice-pace'),energy:$('voice-energy'),label:$('voice-label'),save:$('voice-save'),reset:$('voice-reset'),draftPreview:$('voice-draft-preview'),savedPreview:$('voice-saved-preview'),stop:$('voice-stop'),candidates:$('voice-candidates'),activate:$('voice-activate')}});
 const healthInventory=createHealthInventoryView({root:$('health-inventory'),native,assistants:()=>session&&privateAllowed?[...$('assistant').options].filter(option=>option.value).map(option=>({id:option.value,label:option.textContent})):[],owner:()=>session&&privateAllowed&&context?.endpoint?.endpointId&&!document.hidden&&!$('settings-pane').hidden?{session,epoch,endpointId:context.endpoint.endpointId,revision:context.revision}:null,current:job=>!!session&&job.session===session&&job.epoch===epoch&&job.endpointId===context?.endpoint?.endpointId&&job.revision===context?.revision&&privateAllowed&&!document.hidden&&!$('settings-pane').hidden});
 const calendarConnections=createCalendarReconnectView({root:$('calendar-reconnect'),native,owner:()=>session&&privateAllowed&&context?.endpoint?.endpointId&&!document.hidden&&!$('settings-pane').hidden?{session,epoch,endpointId:context.endpoint.endpointId,revision:context.revision}:null,current:job=>!!session&&job.session===session&&job.epoch===epoch&&job.endpointId===context?.endpoint?.endpointId&&job.revision===context?.revision&&privateAllowed&&!document.hidden&&!$('settings-pane').hidden});
 const invalidateConnectionViews=()=>{healthInventory.invalidate();calendarConnections.invalidate()};
 const setContext=value=>{if(context?.endpoint?.endpointId!==value?.endpoint?.endpointId||context?.revision!==value?.revision)invalidateConnectionViews();context=value;};
 const clearDisplay=()=>{epoch++;appearanceLoad?.abort();appearanceLoad=null;renderer?.dispose();renderer=null;const canvas=$('avatar');canvas.replaceWith(canvas.cloneNode(false));$('transcript').replaceChildren();$('intro').hidden=false;};
 const protect=()=>{invalidateConnectionViews();personalAppConfirmed=false;voiceSettings.invalidate();log('privacy_protected');history?.invalidate();historyBusy=false;historyCursor=null;historyConversation=null;newChat=true;chatsLoaded=false;$('history-list').replaceChildren(new Option('[New voice chat]',''));$('history-older').hidden=true;$('history-status').textContent='';if(textState.busy)void native.cancelText().catch(()=>{});textGeneration++;textState={};$('text-input').value='';privateAllowed=false;expires=0;clearDisplay();catalog=null;$('animation-options').replaceChildren();$('physics-options').hidden=true;$('animation-selector-controls').hidden=true;$('animation-selector').replaceChildren();$('physics-status').textContent='Available for appearances with a supported physics profile.';$('animation-status').textContent='Only me activates when you open the app, start listening or send a message.';$('appearance').replaceChildren(new Option('Neutral reference','neutral'));for(let i=1;i<$('assistant').options.length;i++)$('assistant').options[i].textContent=`Assistant ${i}`;$('privacy').textContent='Unknown/shared · private context withheld';};
 const controls=()=>{
  $('health-inventory-panel').hidden=!session||!privateAllowed;$('calendar-connections-panel').hidden=!session||!privateAllowed;
  const active=!!nativeState.active,busy=!!textState.busy,historyUnavailable=historyBusy||!!history?.isPending()||needsChatResolution;renderActivity(nativeState,textState);
  $('history-list').disabled=!session||active||starting||busy||restoring||historyBusy;$('history-older').disabled=!privateAllowed||active||starting||busy||historyBusy||!historyCursor;$('history-older').hidden=!historyCursor;
  if(history?.isPending())$('history-status').textContent='The last change is unconfirmed. Open the chat selector to check it.';
  if(probeActive){$('input-status').textContent=probeMode==='conversation'?'Test mic (no capture)':'Off';$('input-light').dataset.state=probeMode==='conversation'?'ready':'off';$('output-status').textContent='Local audio test';$('output-light').dataset.state='playing';$('audio-detail').textContent='Local test follows the system audio route. Microphone samples are never read, saved or sent.';}
  $('text-input').disabled=!session||active||starting||restoring||busy||historyUnavailable;
  $('send-text').disabled=$('text-input').disabled||!$('assistant').value||!$('text-input').value.trim();
  $('connection').querySelector('button').disabled=restoring;
  for(const id of ['physics-hair','physics-soft','physics-collision'])$(id).disabled=!renderer?.current?.adapter||!privateAllowed;
  for(const id of ['animation-selector','animation-play','animation-auto'])$(id).disabled=!renderer?.current?.adapter||!privateAllowed||!!nativeState.playing;
  $('start').disabled=restoring||!session||!$('assistant').value||active||starting||busy||historyUnavailable;
  $('stop').disabled=!active&&!starting&&!busy&&!probeActive;
  $('finish-speech').hidden=!nativeState.canFinishSpeech;$('finish-speech').disabled=!nativeState.canFinishSpeech;
  $('start').hidden=active||starting||busy||probeActive;$('stop').hidden=!$('start').hidden;
  $('probe-stop').disabled=!probeActive;for(const id of ['probe-media','probe-conversation'])$(id).disabled=restoring;
  for(const id of ['assistant','background'])$(id).disabled=active||starting||busy||!session;
  for(const id of ['appearance','apply-appearance'])$(id).disabled=active||starting||busy||!session||!privateAllowed;
  $('sign-out').hidden=!session;$('session-panel').hidden=!session;$('session-privacy').hidden=!session;$('unlock-session').hidden=!session||privateAllowed||personalSnapshot?.personalSessionPolicy==='personalApp';$('lock-session').hidden=!session||personalSnapshot?.personalSessionPolicy==='personalApp';$('unlock-session').disabled=!!pendingLock;$('pending-lock-notice').hidden=!unresolvedElsewhere;
 };
 const run=fn=>async event=>{event?.preventDefault();try{await fn();}catch(error){if(error.code==='personal_session_reauthentication_required'){pane(true);status('Sign in again to open your personal session. The previous server session is not automatically revoked.');}else status(pendingLock?.mismatch?'Locked on this phone. The previous server session may still be open; its withdrawal must be confirmed before this phone can unlock.':pendingLock?'Locked on this phone. Server confirmation is pending. Retry Lock when connected.':error.status>=500?'Connection unavailable. Your conversation is unchanged. Retry when connected.':error.message);}finally{controls();}};
 trackConversationViewport($('transcript'));
 function message(role,text,trace,append=false,groupVoice=false){
  if(document.hidden||!privateAllowed)return;
  appendConversationMessage($('transcript'),{role,text,trace,append,groupVoice});
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
 const personalValue=value=>value?.personalSessionPolicy==='personalDevice'&&['unlocked','locked'].includes(value.personalSessionState)&&typeof value.privateAllowed==='boolean'&&typeof value.personalSessionEpoch==='string'&&Number.isSafeInteger(value.revision)&&value.expiresAt===null&&value.leaseId===null;
 const personalAppValue=value=>value?.personalSessionPolicy==='personalApp'&&value.personalSessionState==='authenticated'&&value.enforced===true&&value.privateAllowed===true&&value.principalId===session?.principalId&&value.authenticatedSessionId===session?.sessionId&&Number.isSafeInteger(value.revision)&&value.revision>=0&&(value.expiresAt===null||(typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt))&&Date.parse(value.expiresAt)>Date.now()))&&value.leaseId===null&&value.leaseExpiresAt===null;
 async function checkPersonalSession(isCurrent,unlock=false,observed=null){
  const value=observed??await api('/api/runtime/v1/audience/personal-session');if(!isCurrent())return null;
  if(!personalValue(value)&&!personalAppValue(value)){protect();throw Error('This server has not confirmed personal-phone session support.');}
  personalSnapshot=value;
  if(personalAppValue(value)){if(value.revision!==context?.revision){protect();throw Error('The personal session changed. Reconnect and try again.');}const admitted=await native.pendingPersonalLock();if(!isCurrent())return null;personalAppConfirmed=admitted.personalAppConfirmed===true;unresolvedElsewhere=admitted.unresolvedElsewhere===true;if(pendingLock||!personalAppConfirmed||admitted.state!=='none'){protect();return null;}privateAllowed=true;userLocked=false;$('privacy').textContent='Personal session open';return value;}
  if(pendingLock){protect();return null;}
  if(value.personalSessionState==='unlocked'&&value.privateAllowed){privateAllowed=true;userLocked=false;$('privacy').textContent='Personal session open';return value;}
  if(!unlock){userLocked=true;protect();return null;}
  if(pendingLock)throw Error('Confirm the requested Lock before opening a new session.');
  const opened=await api('/api/runtime/v1/audience/personal-session',{operation:'unlock',operationId:crypto.randomUUID(),declarationId:crypto.randomUUID(),expectedAudienceRevision:value.revision,expectedPersonalSessionEpoch:value.personalSessionEpoch,expectedSessionRevision:context.revision,endpointId:context.endpoint.endpointId,expectedEndpointRevision:context.endpoint.configurationRevision});
  if(!isCurrent())return null;
  if(!personalValue(opened)||opened.personalSessionState!=='unlocked'||opened.privateAllowed!==true){protect();throw Error('Personal session Unlock was not confirmed.');}
  personalSnapshot=opened;privateAllowed=true;userLocked=false;$('privacy').textContent='Personal session open';return opened;
 }
 // Deliberate actions refresh state once. No room declaration, renewal or polling.
 async function activatePersonalSession(isCurrent,{unlock=false,configure=false}={}){
  personalGeneration++;
  try{
   await api('/api/auth/v1/user-context');if(!isCurrent())return null;
   // Reconcile exact old-session withdrawals before mutating endpoint bindings.
   const before=await native.pendingPersonalLock();if(!isCurrent())return null;
   if(before.state==='matching'||(before.state==='mismatch'&&!(unlock&&configure))){
    const beforePolicy=await api('/api/runtime/v1/audience/personal-session');if(!isCurrent())return null;
    if(personalAppValue(beforePolicy)){
     const confirmed=await native.pendingPersonalLock();if(!isCurrent())return null;
     if(!confirmed.personalAppConfirmed || confirmed.state!=='none'){protect();throw Error('A withdrawal for this current session remains unconfirmed. Sign out and sign in again.');}
    }else if(before.state==='matching'){
     pendingLockBody=before.body;pendingLock=JSON.parse(before.body);userLocked=true;protect();
     const locked=await api('/api/runtime/v1/audience/personal-session',pendingLockBody);if(!isCurrent())return null;
     if(!personalValue(locked)||locked.privateAllowed!==false||locked.personalSessionState!=='locked')throw Error('The requested Lock is still unconfirmed.');pendingLock=null;pendingLockBody=null;
    }else{pendingLock={mismatch:true};protect();throw Error('The previous server session may still be open. Sign in again to use this phone.');}
   }else if(before.state!=='none'&&!(before.state==='mismatch'&&unlock&&configure))throw Error('Pending Lock state is unavailable.');
   let current=await api('/api/runtime/v1/session-context');if(!isCurrent())return null;
   if(current.endpoint?.endpointClass!=='personalCompanion'){
    if(!configure){protect();throw Error('The selected endpoint changed. Reconnect this personal phone.');}
    current=await api('/api/runtime/v1/session-context',{expectedRevision:current.revision,bindingKey:crypto.randomUUID(),endpointClass:'personalCompanion',mode:'audio',audienceScope:'authenticatedSession'});
   }else if(!current.endpoint?.inputModalities?.includes('audio')){
    current=await api('/api/runtime/v1/session-context',{expectedRevision:current.revision,mode:'audio',audienceScope:'authenticatedSession'});
   }
   if(!isCurrent())return null;setContext(current);
   if(current.endpoint?.privacyClass!=='personal'||current.endpoint?.ownership!=='personal'){protect();throw Error('This endpoint is not your personal phone.');}
   let observed=await api('/api/runtime/v1/audience/personal-session');if(!isCurrent())return null;
   const pending=await native.pendingPersonalLock();if(!isCurrent())return null;unresolvedElsewhere=pending.unresolvedElsewhere===true;personalAppConfirmed=pending.personalAppConfirmed===true;if(personalAppValue(observed)&&!personalAppConfirmed){protect();throw Error(pending.state==='matching'?'A withdrawal for this current session remains unconfirmed. Sign out and sign in again.':'This phone could not confirm the current personal session.');}controls();
   if(pending.state==='mismatch'){pendingLock={mismatch:true};userLocked=true;protect();throw Error('Locked on this phone. The previous server session may still be open. This Lock will not be replayed under another session; its withdrawal remains unconfirmed.');}
   if(pending.state==='matching'){
    if(personalAppValue(observed)){pendingLock={mismatch:true};protect();throw Error('A withdrawal for this current session remains unconfirmed. Sign out and sign in again.');}
    pendingLockBody=pending.body;pendingLock=JSON.parse(pending.body);userLocked=true;protect();
    const locked=await api('/api/runtime/v1/audience/personal-session',pendingLockBody);if(!isCurrent())return null;
    if(!personalValue(locked)||locked.privateAllowed!==false||locked.personalSessionState!=='locked')throw Error('The requested Lock is still unconfirmed.');
    pendingLock=null;pendingLockBody=null;observed=null;
   }else if(pending.state!=='none')throw Error('Pending Lock state is unavailable.');
   if(pending.state==='none'&&personalAppValue(observed)){pendingLock=null;pendingLockBody=null;}
   const value=await checkPersonalSession(isCurrent,unlock,observed);if(!value||!isCurrent())return null;return current;
  }catch(error){
   if(isCurrent()&&(error.status===401||error.status===403)){userLocked=true;protect();}
   if(isCurrent()&&error.status!==401&&error.status!==403)status('Connection unavailable. Your conversation is unchanged. Retry when connected.');
   throw error;
  }
 }
 async function refresh(){
  if(!session||refreshing)return;refreshing=true;
  try{
   const identity=session;setContext(await api('/api/runtime/v1/session-context'));await checkPersonalSession(()=>identity===session);
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
 async function bindSession(account,ticket,freshSignIn=false){
  if(ticket!==connectionGeneration)return;
  if(!account?.sessionId)throw Error('Server did not return a session.');
  invalidateConnectionViews();session=account;const audience=await activatePersonalSession(()=>ticket===connectionGeneration,{unlock:freshSignIn,configure:true});
  if(ticket!==connectionGeneration)return;await refresh();pane(false);if(!audience)return;await loadChats();log('connection_restore_done');status('Connected. Only me is active; tap Start to listen or send a message.');
 }
 async function restore(){
  if(restoring)return;invalidateConnectionViews();log('connection_restore_start');
  const ticket=++connectionGeneration;startGeneration++;starting=false;restoring=true;if(!session){personalSnapshot=null;protect();}controls();
  try{
   const saved=await native.restoreConnection();if(ticket!==connectionGeneration)return;
   if(saved.endpoint){$('server').value=saved.endpoint;$('username').value=saved.username??'';savedIdentity=JSON.stringify([saved.endpoint,saved.username??'']);loadSettings(saved.settings);}
   $('retry-connection').hidden=!saved.hasSession&&!saved.hasSavedCredentials;
   if(saved.authState==='offline')throw Error('Check your private server and VPN connection.');
   if(saved.authState==='needsOneTimeCode'){pane(true);status('Your previous sign-in used an authenticator code. Sign in with a fresh code if required; otherwise leave it blank.');return;}
   if(!saved.hasSession){status(saved.endpoint?'Saved server and account restored. Sign in once to enable automatic sign-in.':'Connect to your existing private Assistant server in Settings.');return;}
   status('Reconnecting to your saved server…');await bindSession(saved.account??await api('/api/auth/v1/session'),ticket);$('retry-connection').hidden=true;
  }catch(error){if(ticket!==connectionGeneration)return;log('connection_restore_failed');if(error.code==='personal_session_reauthentication_required'){personalSnapshot=null;protect();pane(true);status('Sign in again to open your personal session. The previous server session is not automatically revoked.');}else if(error.status===401||error.status===403){session=null;personalSnapshot=null;protect();await native.forgetSession();$('retry-connection').hidden=true;status('Your saved session expired or was revoked. Sign in again in Settings.');}else{status('Saved connection is currently unavailable. Open Settings to reconnect. '+error.message);}}
  finally{if(ticket===connectionGeneration){restoring=false;controls();}}
 }
 const diagnosticStatus=async()=>{if(typeof native.diagnosticsStatus!=='function'){$('verbose-diagnostics').disabled=true;$('share-diagnostics').disabled=true;$('clear-diagnostics').disabled=true;return;}const value=await native.diagnosticsStatus();diagnosticEnabled=value.enabled===true;$('audit-indicator').hidden=value.auditActive!==true&&value.auditStopping!==true;$('audit-indicator').textContent=value.auditStopping?'Diagnostic capture may still be stopping.':value.auditContent?'Diagnostic session enabled; foreground speech content and audio may be recorded.':'Diagnostic session enabled. Start foreground listening to capture.';$('verbose-diagnostics').checked=diagnosticEnabled;$('verbose-diagnostics-status').textContent=value.storageError?'Diagnostics storage is unavailable on this phone.':`${diagnosticEnabled?'Diagnostics are on':'Diagnostics are off'} · ${Number.isSafeInteger(value.count)?value.count:0} events stored.`;};
 $('verbose-diagnostics').onchange=run(async()=>{const value=await native.setDiagnosticsEnabled({enabled:$('verbose-diagnostics').checked});diagnosticEnabled=value.enabled===true;await diagnosticStatus();});
 $('share-audit-diagnostics').onclick=run(async()=>{const button=$('share-audit-diagnostics');button.disabled=true;try{await shareOptionalCapture(native,$('audit-share-status'));}finally{button.disabled=false;}});
 $('share-diagnostics').onclick=run(async()=>{const notice=$('routine-share-status'),button=$('share-diagnostics');button.disabled=true;notice.textContent='Preparing diagnostic log…';try{const result=await native.shareDiagnostics();notice.textContent=result.shared?'Diagnostic log shared.':'Sharing cancelled.';}catch(error){const allowed=['There are no diagnostic events to share yet.','The diagnostic file could not be prepared on this device.','Open the app and close other panels before sharing diagnostics.'];notice.textContent=allowed.includes(error?.message)?error.message:'Could not open diagnostic sharing. Try again.';}finally{button.disabled=false;}});
 $('clear-diagnostics').onclick=run(async()=>{await native.clearDiagnostics();await diagnosticStatus();});
 void diagnosticStatus().catch(()=>{$('verbose-diagnostics-status').textContent='Diagnostics are unavailable.';});
 $('open-settings').onclick=run(async()=>{if(probeActive)await native.stopAudioProbe();pane(true);});$('close-settings').onclick=run(async()=>{invalidateConnectionViews();voiceSettings.invalidate();if(probeActive)await native.stopAudioProbe();pane(false);});
 $('retry-connection').onclick=run(restore);
 $('connection').onsubmit=run(async()=>{
  log('sign_in_start');const ticket=++connectionGeneration;restoring=true;startGeneration++;personalSnapshot=null;protect();session=null;context=null;controls();
  try{
   const endpoint=$('server').value.trim().replace(/\/$/,''),username=$('username').value.trim().toLowerCase(),identity=JSON.stringify([endpoint,username]);
   if(identity!==savedIdentity)loadSettings('{}');savedIdentity=identity;$('assistant').replaceChildren(new Option('Choose an Assistant',''));
   await native.configure({endpoint,username});$('retry-connection').hidden=true;
   let account;try{account=await api('/api/auth/v1/sign-in',{username,password:$('password').value,...($('totp').value?{totp:$('totp').value}:{})});}finally{$('password').value='';$('totp').value='';}
   $('retry-connection').hidden=false;await bindSession(account.session,ticket,true);log('sign_in_done');$('retry-connection').hidden=true;
  }catch(error){log('sign_in_failed');if(ticket===connectionGeneration){session=null;protect();}throw error;}finally{if(ticket===connectionGeneration)restoring=false;}
 });
 $('start').onclick=run(async()=>{
  const ticket=++startGeneration;starting=true;textState={};controls();try{let current=await activatePersonalSession(()=>ticket===startGeneration&&!!session&&!document.hidden);if(!current||ticket!==startGeneration||!privateAllowed||document.hidden)return;current=await ensureChat(()=>ticket===startGeneration&&!!session&&!document.hidden);if(!current||ticket!==startGeneration)return;
   nativeState=await native.start({request:{sessionId:session.sessionId,expectedSessionRevision:current.revision,endpointId:current.endpoint.endpointId,assistantId:$('assistant').value},background:$('background').checked});status(nativeState.phase??'Connecting native audio…');refreshDisplay();
  }finally{if(ticket===startGeneration)starting=false;}
 });
 $('finish-speech').onclick=run(async()=>{nativeState=await native.finishUtterance();status('Transcribing your speech…');});
 $('stop').onclick=run(async()=>{startGeneration++;textGeneration++;textState={};starting=false;nativeState=await native.stop();chatsLoaded=false;status('Conversation stopped. Microphone and playback are off.');});
 const localProbe=mode=>run(async()=>{
  const ticket=++probeGeneration;startGeneration++;textGeneration++;starting=false;textState={};probeActive=true;probeMode=mode;controls();
  $('probe-status').textContent='Stopping the conversation for a local audio test…';
  try{await native.startAudioProbe({mode});}catch(error){if(ticket===probeGeneration){probeActive=false;$('probe-status').textContent=error.message;}throw error;}
 });
 $('probe-media').onclick=localProbe('media');$('probe-conversation').onclick=localProbe('conversation');
 $('probe-stop').onclick=run(async()=>{probeGeneration++;await native.stopAudioProbe();probeActive=false;});
 $('copy-audio-diagnostics').onclick=run(async()=>{try{await native.copyAudioDiagnostics();$('diagnostics-copy-status').textContent='Diagnostics copied on this phone. Clipboard copy expires in 5 minutes.';}catch(error){$('diagnostics-copy-status').textContent=error.message;throw error;}});
 history=createMobileHistory({api,owner:()=>session&&privateAllowed&&!document.hidden?{session,principalId:session.principalId,assistantId:$('assistant').value,epoch}:null,current:value=>session===value.session&&privateAllowed&&!document.hidden&&epoch===value.epoch&&$('assistant').value===value.assistantId,afterSelect:async()=>{const ticket=epoch,identity=session;const ready=await activatePersonalSession(()=>ticket===epoch&&identity===session&&!document.hidden);if(!ready)throw Error('The selected conversation could not restore its private audience.');}});
 const showHistory=result=>{historyCursor=result.cursor;historyConversation=result.selected?.conversationId??null;$('transcript').replaceChildren();for(const entry of result.entries){const label=entry.speaker==='assistant'?'assistant':'user';const text=entry.content.state==='retained'?entry.content.text:'[Message unavailable under current history settings]';message(label,text,entry.entryId,false,label==='user'&&entry.modality==='voice');}$('history-status').textContent='';controls();};
 async function loadChats(){
  if(!session||historyBusy||nativeState.active||starting||textState.busy)return;const identity=session;historyBusy=true;declaringAudience++;controls();
  try{let reconciledSelection=null;if(!privateAllowed){const ready=await activatePersonalSession(()=>session===identity&&!document.hidden);if(!ready)return;}if(history.isPending()){const state=await history.view();if(state.reconciliation==='created'){needsChatResolution=true;$('history-status').textContent='A previous chat was created. Select a chat before continuing.';}else if(state.reconciliation==='pending'){needsChatResolution=true;$('history-status').textContent='The previous change is still unconfirmed.';}else if(state.reconciliation==='selected'){needsChatResolution=false;newChat=false;showHistory(state);reconciledSelection=state.selected?.conversationId??null;}else if(state.reconciliation){needsChatResolution=false;$('history-status').textContent='The previous change was not applied.';}}
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
 $('history-older').onclick=run(async()=>{if(!historyCursor||!historyConversation||historyBusy)return;historyBusy=true;controls();try{const page=await history.older(historyConversation,historyCursor);historyCursor=page.cursor;$('transcript').replaceChildren();for(const entry of page.entries)message(entry.speaker==='assistant'?'assistant':'user',entry.content.state==='retained'?entry.content.text:'[Message unavailable under current history settings]',entry.entryId,false,entry.speaker!=='assistant'&&entry.modality==='voice');$('history-status').textContent='';}finally{historyBusy=false;controls();}});
 $('animation-play').onclick=run(async()=>{log('animation_selected');if(!renderer?.motionAction('clip',$('animation-selector').value))throw Error('Animation is unavailable while speech is playing.');$('animation-status').textContent='Selected animation playing.';});
 $('animation-auto').onclick=run(async()=>{log('animation_automatic');if(!renderer?.motionAction('cycle'))throw Error('Automatic animation is unavailable while speech is playing.');$('animation-status').textContent='Automatic animation resumed.';});
 $('text-input').oninput=controls;
 $('text-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send-text').disabled)$('text-chat').requestSubmit();}};
 $('text-chat').onsubmit=run(async()=>{
  const prompt=$('text-input').value.trim();if(!prompt||textState.busy)return;
  if(!session||!$('assistant').value||nativeState.active||starting||restoring)throw Error('Stop listening and select an Assistant before sending text.');
  const ticket=++textGeneration,trace=crypto.randomUUID(),assistantId=$('assistant').value,owner=session;
  textState={busy:true};controls();status('Checking the current conversation…');
  try{const current=await activatePersonalSession(()=>ticket===textGeneration&&!!session&&!document.hidden);if(!current||ticket!==textGeneration||!privateAllowed||document.hidden)return;await ensureChat(()=>ticket===textGeneration&&!!session&&!document.hidden);if(ticket!==textGeneration||!privateAllowed||document.hidden)return;
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
  log('sign_out');connectionGeneration++;startGeneration++;starting=false;personalSnapshot=null;protect();await native.stop();let remoteFailed=false;try{await api('/api/auth/v1/sign-out',{});}catch{remoteFailed=true;}finally{session=null;nativeState={};$('retry-connection').hidden=true;await native.forgetSession();pane(true);status(remoteFailed?'Signed out on this phone. The server was unavailable; its session could not be revoked.':'Signed out. Server and account details are remembered.');}
 });
 void native.addListener('event',event=>{
  if(event.type==='audit'){$('audit-indicator').hidden=event.active!==true&&event.stopping!==true;$('audit-indicator').textContent=event.stopping?'Diagnostic capture may still be stopping.':event.contentEnabled?'Diagnostic session enabled; foreground speech content and audio may be recorded.':'Diagnostic session enabled. Start foreground listening to capture.';}
  else if(event.type==='audioProbe'){probeActive=event.active===true;if(event.mode==='media'||event.mode==='conversation')probeMode=event.mode;$('probe-status').textContent=String(event.status??'').slice(0,500);$('probe-detail').textContent=String(event.diagnostics??'').slice(0,2000);$('probe-detail').hidden=!$('probe-detail').textContent;controls();}
  else if((event.type==='audience'||event.type==='personalSession')&&!event.active){startGeneration++;starting=false;if(event.authoritative===true||event.type==='personalSession'){userLocked=true;personalSnapshot=null;protect();}status(event.reason??'Conversation transport stopped.');controls();}
  else if(event.type==='state'){
   nativeState=event.state;$('route').textContent=event.state.route||'System route';if(!textState.busy)status(event.state.phase);
   renderer?.applyState(event.state.playing?'speaking':event.state.active?'listening':'idle');
   if(event.state.authorizationLost===true){userLocked=true;personalSnapshot=null;protect();}controls();
  }else if(event.type==='transcript')message('user',event.text,event.trace,false,true);else if(event.type==='textDelta')message('assistant',event.text,event.trace,true);
 });
 $('unlock-session').onclick=run(async()=>{if(!session)return;const ticket=connectionGeneration;await activatePersonalSession(()=>ticket===connectionGeneration&&!document.hidden,{unlock:true});if(privateAllowed){await refresh();status('Personal session unlocked. Tap Start when ready.');}});
 $('lock-session').onclick=run(async()=>{
  const identity=session,saved=personalSnapshot,selected=context;userLocked=true;startGeneration++;starting=false;protect();await native.stop();
  if(!identity||!saved||!selected?.endpoint)return;
  pendingLock??={operation:'lock',operationId:crypto.randomUUID(),declarationId:saved.personalSessionId??crypto.randomUUID(),expectedAudienceRevision:saved.revision,expectedPersonalSessionEpoch:saved.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint.endpointId,expectedEndpointRevision:selected.endpoint.configurationRevision};
  pendingLockBody??=JSON.stringify(pendingLock);
  try{const locked=await api('/api/runtime/v1/audience/personal-session',pendingLockBody);if(!personalValue(locked)||locked.privateAllowed!==false||locked.personalSessionState!=='locked')throw Error('Lock is unconfirmed.');pendingLock=null;pendingLockBody=null;status('Personal session locked.');}
  catch(error){status('Locked on this phone. Server confirmation is unavailable; retry Lock when connected.');throw error;}
 });
 const resume=async()=>{nativeState=await native.snapshot();controls();if(session){await activatePersonalSession(()=>!!session&&!document.hidden);await refresh();}else await restore();};
 const updateComposerViewport=()=>{const viewport=window.visualViewport;const inset=viewport?Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop):0;document.documentElement.style.setProperty('--keyboard-inset',`${Math.round(inset)}px`);};
 window.visualViewport?.addEventListener('resize',updateComposerViewport);window.visualViewport?.addEventListener('scroll',updateComposerViewport);window.addEventListener('resize',updateComposerViewport);updateComposerViewport();
 document.addEventListener('lifestream-native-resume',()=>{void resume().catch(error=>status(error.message));});
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden){probeGeneration++;probeActive=false;void native.stopAudioProbe?.().catch(()=>{});protect();}
  else void resume().catch(error=>status(error.message));
 });
 window.addEventListener('pagehide',()=>{probeGeneration++;probeActive=false;void native.stopAudioProbe?.().catch(()=>{});protect();});
 controls();status('Restoring saved connection…');void restore();
 return {refresh,api,get state(){return {session,privateAllowed,nativeState}}};
}
