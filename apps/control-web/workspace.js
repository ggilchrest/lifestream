// Navigation changes presentation only. Existing modules retain their scoped state,
// server authorization, revision checks and cancellation listeners.
export function installWorkspace() {
  const $ = selector => document.querySelector(selector);
  const editor = $('.editor'), rail = $('.rail');
  const destinations = [
    ['profile','Assistant profile','Identity, presentation and version history.',['#profile-editor','#profile-rollback'],'Manage'],
    ['person','People & context','Your profile and the context you choose to share.',['#user-profile'],'Manage'],
    ['relationship','Relationship setup','Start or skip a relationship review for the selected Assistant.',['#relationship-overview'],'Manage'],
    ['intake','Import & review','Inventory selected files, review candidates, then admit your choices.',['.profile-builder'],'Context'],
    ['records','Records','Find, review and maintain the context your Assistant may use.',['#relationship-administration'],'Context'],
    ['settings','Settings & replies','Prepare a configuration, review it, then activate it.',['.relationship-config-tools'],'Context'],
    ['initiative','Initiative & attention','Review initiative, output scope and limits.',['.relationship-initiative'],'Context'],
    ['discovery','Understanding & discovery','Review discovery, sources and preparation limits.',['.relationship-understanding'],'Context'],
    ['insights','Insights & feedback','Five perspectives on your records, with evidence and reviewable proposals.',['.relationship-insights'],'Evaluate'],
    ['lab','Relationship Lab','Compare isolated alternatives before promoting a draft for review.',['.relationship-lab'],'Evaluate'],
    ['readiness','Readiness','Inspect eligibility, exclusions and readiness without starting training.',['.relationship-readiness'],'Evaluate'],
    ['privacy','Privacy & recovery','Preview a precise target before changing retention or recovery state.',['.relationship-recovery'],'Protect'],
    ['session','Session disclosure','Control whether this session can use your approved private context.',['#session-context-panel'],'Protect'],
    ['account','Account & access','Manage sign-in, recovery codes and authentication.',['#authentication-panel'],'Protect'],
    ['memory','Assistant memory','Review memory candidates, corrections and their history.',['#assistant-memory'],'Advanced'],
    ['adaptations','Persona proposals','Review evidence before approving a change in expression.',['#assistant-adaptations'],'Advanced'],
  ];
  $('.hero').hidden = true;
  const header = document.createElement('header');header.className='workspace-heading';
  header.innerHTML='<div><p class="eyebrow" id="page-group"></p><h1 id="page-title" tabindex="-1"></h1><p id="page-description"></p></div><a class="guide-link" href="/control/security.html">Permissions ↗</a>';
  editor.prepend(header);
  const nav=document.createElement('nav');nav.className='workspace-nav';nav.setAttribute('aria-label','Control room');
  let group='';
  for(const [id,label,description,selectors,category] of destinations){
    if(group!==category){const heading=document.createElement('p');heading.className='nav-group';heading.textContent=category;nav.append(heading);group=category;}
    const link=document.createElement('a');link.href='#'+id;link.dataset.destination=id;link.textContent=label;nav.append(link);
    const view=document.createElement('div');view.className='workspace-view';view.dataset.view=id;view.hidden=true;
    for(const selector of selectors){const element=$(selector);if(element)view.append(element);}
    editor.append(view);
  }
  rail.append(nav);
  // Move permissions to the workspace heading; retain one unambiguous destination.
  rail.querySelector('.text-link')?.remove();
  const toggle=document.createElement('button');toggle.className='nav-toggle secondary';toggle.type='button';toggle.textContent='Navigate workspace';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls','control-navigation');nav.id='control-navigation';rail.insertBefore(toggle,nav);
  toggle.onclick=()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));rail.classList.toggle('navigation-open',open);};
  const notification=document.createElement('div');notification.className='workspace-notification';notification.hidden=true;notification.setAttribute('role','status');notification.setAttribute('aria-live','polite');
  notification.innerHTML='<span></span><button type="button" class="quiet" aria-label="Dismiss notification">×</button>';document.body.append(notification);notification.querySelector('button').onclick=()=>{notification.hidden=true;};
  let active='';
  const navigate=(id,focus=true)=>{
    const allowed=window.lifestreamAuth.mode!=='local-password'||!!window.lifestreamAuth.session;
    if(!allowed)id='account';
    const entry=destinations.find(item=>item[0]===id)||destinations[0];id=entry[0];
    if(active!==id){notification.hidden=true;notification.querySelector('span').textContent='';}active=id;
    for(const view of editor.querySelectorAll('[data-view]'))view.hidden=view.dataset.view!==id;
    for(const link of nav.querySelectorAll('a')){if(link.dataset.destination===id)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    $('#page-title').textContent=entry[1];$('#page-description').textContent=entry[2];$('#page-group').textContent=entry[4]+' / CONTROL ROOM';document.title=entry[1]+' · Lifestream';
    // A signed-out user still needs the sign-in page. Other content stays hidden.
    $('.workspace').hidden=false;rail.hidden=!allowed;
    if(location.hash!=='#'+id)history.replaceState(null,'','#'+id);
    rail.classList.remove('navigation-open');toggle.setAttribute('aria-expanded','false');
    if(focus){$('#page-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
  };
  nav.onclick=event=>{const link=event.target.closest('[data-destination]');if(link){event.preventDefault();location.hash=link.dataset.destination;}};
  window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
  window.addEventListener('lifestream-auth',()=>{notification.hidden=true;notification.querySelector('span').textContent='';navigate(active==='account'&&window.lifestreamAuth.session&&$('#auth-recovery-codes').hidden?'profile':active,false);});
  window.addEventListener('lifestream-assistant',()=>{notification.hidden=true;notification.querySelector('span').textContent='';});
  window.lifestreamUI={navigate:id=>{location.hash=id;navigate(id);},notify:(message,error)=>{notification.querySelector('span').textContent=message;notification.classList.toggle('error',!!error);notification.hidden=false;}};
  navigate(location.hash.slice(1)||'profile',false);
}
