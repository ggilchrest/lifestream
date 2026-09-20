// Disclosure begins protected. A lost evidence channel never leaves private content visible.
(() => {
 const root=document.documentElement;if(root.dataset.audienceEnforced!=='true')return;
 let snapshot,events,epoch=0,heartbeat=0,lastKey='',nativeLocked=false;
 const panel=document.createElement('section');panel.className='card audience-panel';panel.setAttribute('aria-label','Audience privacy');
 panel.innerHTML='<h2>Audience privacy</h2><p data-audience-status role="status">Audience unknown. Private context and displays are protected.</p><p>Automatic evidence must be fresh and cover this endpoint. A temporary declaration is a manual fallback.</p><div class="actions"><button type="button" data-audience-solo>Only me · 5 minutes</button><button type="button" data-audience-shared class="secondary">Shared audience</button><button type="button" data-audience-clear class="secondary">Clear declaration</button><button type="button" data-audience-refresh class="secondary">Refresh audience</button></div>';
 document.querySelector('main')?.prepend(panel);const status=panel.querySelector('[data-audience-status]');
 const protect=(value,reason)=>{
  const allowed=!!value?.privateAllowed&&!document.hidden&&!nativeLocked&&!!window.lifestreamAuth?.session;
  root.dataset.audienceProtected=String(!allowed);snapshot=value;const key=JSON.stringify([allowed]);
  if(key!==lastKey){lastKey=key;window.dispatchEvent(new CustomEvent('lifestream-audience',{detail:{privateAllowed:allowed,classification:value?.classification??'unknown'}}));for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();}
  status.textContent=reason??`${value?.classification??'unknown'} · ${value?.basis??'unavailable'}${value?.expiresAt?' · expires '+new Date(value.expiresAt).toLocaleTimeString():''}. ${allowed?'Private display permitted; session disclosure still controls context.':'Private context and displays protected. Generic conversation remains available.'}`;
 };
 const offline=()=>protect(null,'Audience evidence is unavailable. Private context and displays are protected.');
 const stop=()=>{epoch++;events?.close();events=null;heartbeat=0;offline();};
 const refresh=async()=>{
  stop();if(!window.lifestreamAuth?.session||document.hidden)return;
  const ticket=epoch,value=await window.lifestreamAuth.request('/api/runtime/v1/audience');if(ticket!==epoch)return;protect(value);heartbeat=performance.now();
  events=new EventSource('/api/runtime/v1/audience/events');events.onmessage=event=>{if(ticket!==epoch)return;try{const value=JSON.parse(event.data);heartbeat=performance.now();protect(value);}catch{offline();}};events.onerror=()=>{if(ticket===epoch)offline();};
 };
 const declare=async mode=>{await window.lifestreamAuth.request('/api/runtime/v1/audience',{mode,seconds:300},true);await refresh();};
 const run=fn=>()=>void fn().catch(error=>{offline();status.textContent=error.message;});
 panel.querySelector('[data-audience-solo]').onclick=run(()=>declare('solo'));panel.querySelector('[data-audience-shared]').onclick=run(()=>declare('shared'));panel.querySelector('[data-audience-clear]').onclick=run(()=>declare('clear'));panel.querySelector('[data-audience-refresh]').onclick=run(refresh);
 for(const event of ['lifestream-auth','lifestream-session-context'])window.addEventListener(event,run(refresh));
 const timer=setInterval(()=>{if(heartbeat&&performance.now()-heartbeat>2000||snapshot?.expiresAt&&Date.parse(snapshot.expiresAt)<=Date.now())offline();},100);
 document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();if(window.lifestreamAuth?.session)void declare('lock').catch(()=>{});}else if(window.lifestreamAuth?.session)void declare('unlock').catch(()=>{});});
 window.lifestreamDesktop?.onPrivacyLock?.(locked=>{nativeLocked=locked;protect(null);if(window.lifestreamAuth?.session)void declare(locked?'lock':'unlock').catch(()=>{});});
 window.addEventListener('pagehide',()=>{stop();clearInterval(timer);});
 void window.lifestreamAuth.ready.then(async()=>{if(window.lifestreamAuth.session&&!document.hidden&&!nativeLocked)await window.lifestreamAuth.request('/api/runtime/v1/audience',{mode:'unlock'},true);await refresh();}).catch(offline);
})();
