// Reuse mounted controls; keep the owning module's handlers and revision guards.
export function installWorkflows() {
  const q=selector=>document.querySelector(selector);
  function wrapRange(first,last,title,number){
    if(!first||!last)return;
    const section=document.createElement('section');section.className='workflow-step';
    const heading=document.createElement('h4');heading.textContent=title;
    const step=document.createElement('p');step.className='step-number';step.textContent='Step '+number;
    first.before(section);section.append(step,heading);
    let node=first;
    while(node){const next=node.nextSibling;section.append(node);if(node===last)break;node=next;}
    return section;
  }
  const tuning=q('.relationship-config-tools');
  const saved=q('#tuning-saved').closest('label');
  const save=q('#relationship-config-save'),refresh=q('#tuning-refresh'),inspect=q('#relationship-config-inspect');
  const topActions=save.closest('.actions');
  const reviewActions=q('#tuning-preview').closest('.actions');
  const results=q('#relationship-config-results');
  const controls=q('#tuning-controls').closest('details');controls.open=false;
  const edit=wrapRange(tuning.querySelector('.relationship-config-grid'),controls.nextElementSibling,'Choose your preferences',1);
  // Saving follows the controls it saves, never precedes them.
  edit.append(save);topActions.remove();
  const review=wrapRange(reviewActions,results,'Review and activate a saved draft',2);
  const selection=document.createElement('div');selection.className='form-grid';selection.append(saved,refresh);review.insertBefore(selection,reviewActions);
  const prepareActions=document.createElement('div');prepareActions.className='actions';prepareActions.append(q('#relationship-config-rollback'),q('#relationship-config-reset'));selection.after(prepareActions);
  const helper=document.createElement('p');helper.className='muted';helper.textContent='Select a saved draft, or prepare a rollback from an earlier configuration. Preview its changes below; activation becomes available after a current preview.';prepareActions.after(helper);
  // Preview -> its result -> activation, in reading order.
  review.append(q('#tuning-preview'),results,q('#relationship-config-activate'));
  reviewActions.remove();
  const inspectionStart=review.nextElementSibling;
  const inspection=wrapRange(inspectionStart,q('#inspection-prompt-panel'),'Try an ordinary reply',3);inspection.prepend(inspect);
  const nav=document.createElement('nav');nav.className='subnav';nav.setAttribute('aria-label','Settings workflow');
  const panes=[['edit','Edit preferences',edit],['review','Review & activate',review],['inspect','Inspect replies',inspection]];
  let current='edit';
  const select=(id,focus=false)=>{current=id;for(const [key,,pane]of panes)pane.hidden=key!==id;for(const link of nav.querySelectorAll('button')){link.setAttribute('aria-pressed',String(link.dataset.pane===id));link.className=link.dataset.pane===id?'':'secondary';}if(focus){const pane=panes.find(p=>p[0]===id)[2];pane.tabIndex=-1;pane.focus({preventScroll:true});}};
  for(const [id,label,pane]of panes){pane.dataset.pane=id;const button=document.createElement('button');button.type='button';button.dataset.pane=id;button.textContent=label;button.onclick=()=>select(id,true);nav.append(button);}
  edit.before(nav);select(current);
  // A successful save publishes the selection and result. Move to the reviewed
  // draft only after the owning module has finished; failures stay in the editor.
  const saveHandler=save.onclick;save.onclick=async event=>{const before=results.textContent;await saveHandler(event);if(results.textContent!==before&&results.textContent.startsWith('Saved draft'))select('review',true);};
  const inspectHandler=inspect.onclick;inspect.onclick=async event=>{await inspectHandler(event);const summary=q('#effective-context-summary')||document.createElement('div');summary.id='effective-context-summary';summary.innerHTML=results.innerHTML;inspect.after(summary);};
  document.addEventListener('click',async event=>{const link=event.target.closest('[data-review-configuration]');if(!link)return;event.preventDefault();window.lifestreamUI.navigate('settings');await refresh.onclick();const option=[...q('#tuning-saved').options].find(o=>o.value===link.dataset.reviewConfiguration);if(option){q('#tuning-saved').value=option.value;q('#tuning-saved').dispatchEvent(new Event('change'));select('review',true);}});
  // Privacy: result appears between preview and confirmation; no JSON-only review.
  const privacy=q('.relationship-recovery'),privacyActions=q('#privacy-preview').closest('.actions');
  wrapRange(q('#privacy-action').closest('label'),q('#privacy-targets'),'Choose an action and its sources',1);
  const privacyReview=wrapRange(privacyActions,q('#privacy-preview-result'),'Review the impact, then apply',2);
  privacyReview.append(q('#privacy-apply'));
  const receipts=wrapRange(q('#privacy-receipts'),q('#privacy-receipts'),'Recorded outcomes',3);
  privacy.append(receipts);
  // Lab: separate setup from execution, then put decisions after the result set.
  const lab=q('.relationship-lab');
  wrapRange(lab.querySelector('.relationship-config-grid'),q('#lab-consent').closest('label'),'Define the comparison',1);
  wrapRange(q('#relationship-lab-prepare').closest('.actions'),q('#lab-status'),'Prepare and run',2);
  wrapRange(q('#relationship-lab-results'),q('#lab-promotion'),'Compare results and decide',3);
  for(const event of ['lifestream-assistant','lifestream-relationship','lifestream-auth','lifestream-session-context'])window.addEventListener(event,()=>q('#effective-context-summary')?.replaceChildren());
  const builder=q('.profile-builder');
  wrapRange(builder.querySelector('.form-grid'),q('#builder-inventory').closest('.actions'),'Select files and inventory',1);
  wrapRange(q('#builder-jobs').closest('label'),q('#builder-snapshot').closest('.actions'),'Collect the snapshot and extract candidates',2);
  wrapRange(q('#builder-candidates'),q('#builder-approve').closest('.actions'),'Review, then admit your selection',3);
  // Clear result mirrors on every ownership boundary; originals clear in their modules.
  // Refresh/install calls remain wholly owned by the existing modules.
}
