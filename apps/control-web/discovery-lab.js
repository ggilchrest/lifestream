const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const title=value=>value.replaceAll('-',' ').replace(/^./,c=>c.toUpperCase());

export function installDiscoveryLab({panel,call,guard,status}) {
 panel.innerHTML='<h4 tabindex="-1">Discovery input Lab</h4><p>Compare synthetic conversation inputs before activating a configuration. This Lab does not send anything to a model or change your evidence.</p><form data-discovery-lab-form><label for="discovery-lab-configuration">Configuration to compare</label><select id="discovery-lab-configuration" name="configuration" required></select><p data-lab-configuration-reference class="record-id"></p><button type="submit">Run input comparison</button></form><section data-discovery-lab-result hidden aria-label="Discovery comparison result"><h5 tabindex="-1">Comparison results</h5><p data-lab-summary role="status"></p><details><summary>What this comparison measures</summary><p data-lab-policy></p><p data-lab-source-refs class="record-id"></p></details><label for="discovery-lab-scenario">Scenario</label><select id="discovery-lab-scenario" data-lab-scenario></select><div data-lab-variants class="discovery-lab-variants"></div></section>';
 const dialog=document.createElement('dialog');dialog.className='record-dialog discovery-input-dialog';dialog.setAttribute('aria-labelledby','discovery-input-title');dialog.innerHTML='<form method="dialog"><div class="section-head"><h5 id="discovery-input-title">Assembled input</h5><button type="submit" class="secondary">Close input</button></div></form><div data-lab-input-body></div>';panel.append(dialog);
 const form=panel.querySelector('form'),select=form.elements.configuration,button=form.querySelector('button'),result=panel.querySelector('[data-discovery-lab-result]'),scenario=panel.querySelector('[data-lab-scenario]');let report=null,configurationFingerprint='';
 const clear=()=>{dialog.close();dialog.querySelector('[data-lab-input-body]').replaceChildren();report=null;result.hidden=true;panel.querySelector('[data-lab-variants]').replaceChildren();button.textContent='Run input comparison';};
 const reference=()=>{panel.querySelector('[data-lab-configuration-reference]').textContent=select.value||'Save a Discovery draft in Settings first.';};
 select.onchange=()=>{clear();reference();};
 const renderScenario=()=>{
  dialog.close();const id=scenario.value;
  panel.querySelector('[data-lab-variants]').innerHTML=['baseline','enabled','selected'].map(variant=>{
   const prefix=`lab:${id}:${variant}:`,items=report.explanations.filter(item=>item.code.startsWith(prefix)),checks=items.find(item=>item.code===prefix+'checks'),failed=(checks?.summary.split('\n')||[]).filter(line=>line.startsWith('FAIL:')),passed=(checks?.summary.split('\n')||[]).filter(line=>line.startsWith('PASS:')).length;
   return `<article class="workflow-step"><h6>${{baseline:'Baseline · Discovery off',enabled:'Enabled · reference settings',selected:'Selected configuration'}[variant]}</h6><p class="status ${checks?.summary.includes('FAIL:')?'warning':'active'}">${checks?.summary.includes('FAIL:')?'Input expectation failed':'Input checks passed'}</p><p class="lab-readable-text">${escape(failed.length?failed.join('\n'):`${passed} input checks passed. No model output was evaluated.`)}</p><details><summary>Check details & measurements</summary><p class="lab-readable-text">${escape(checks?.summary||'No result returned')}</p></details><button type="button" class="secondary" data-lab-input="${variant}">Inspect assembled input</button></article>`;
  }).join('');
 };
 panel.querySelector('[data-lab-variants]').onclick=event=>{const trigger=event.target.closest('[data-lab-input]');if(!trigger||!report)return;const prefix=`lab:${scenario.value}:${trigger.dataset.labInput}:`,items=report.explanations.filter(item=>item.code.startsWith(prefix));dialog.querySelector('h5').textContent=`${title(scenario.value)} · ${title(trigger.dataset.labInput)} input`;dialog.querySelector('[data-lab-input-body]').innerHTML=`<pre class="lab-readable-text">${escape((items.find(item=>item.code.endsWith(':input'))?.summary||'').replace('Prepared memory (part 1):','Prepared memory:')+(items.find(item=>item.code.endsWith(':more'))?.summary||'').replace(/^Prepared memory \(continued\):\n/,''))}</pre>`+`<p class="record-id">${escape(items.find(item=>item.code.endsWith(':checks'))?.sourceRefs.join('\n')||'')}</p>`;dialog.showModal();};
 scenario.onchange=renderScenario;
 form.onsubmit=guard(async ticket=>{
  if(!select.value)throw new Error('Save and select a Discovery configuration first.');
  const configurationId=select.value;button.disabled=true;
  try{
   const response=await call({operation:'compare',configurationId,scenario:'understanding-demonstrations-v1'},ticket);
   if(configurationId!==select.value)return;
   const summary=response.explanations.find(item=>item.code==='lab_summary');
   if(!summary){status(response.explanations[0]?.summary||'Comparison is running.');button.textContent='Refresh comparison';return;}
   report=response;result.hidden=false;panel.querySelector('[data-lab-summary]').textContent=summary.summary;panel.querySelector('[data-lab-source-refs]').textContent=summary.sourceRefs.join('\n');panel.querySelector('[data-lab-policy]').textContent=response.explanations.find(item=>item.code==='lab_policy')?.summary||'';
   const ids=[...new Set(response.explanations.filter(item=>item.code.startsWith('lab:')).map(item=>item.code.split(':')[1]))];scenario.innerHTML=ids.map(id=>`<option value="${escape(id)}">${escape(title(id))}</option>`).join('');renderScenario();button.textContent='Refresh comparison';result.querySelector('h5').focus();status('Input comparison completed. Review failed expectations and scope below.');
  }finally{button.disabled=!select.value;}
 });
 return {render(records){
   const configurations=records.filter(record=>record.recordType==='configuration'),fingerprint=JSON.stringify(configurations);
   if(fingerprint!==configurationFingerprint){clear();configurationFingerprint=fingerprint;}
   const previous=select.value;select.innerHTML=configurations.length?configurations.map(record=>`<option value="${escape(record.configurationId)}">Revision ${record.revision} · ${escape(record.lifecycle)} · ${escape(record.configurationId)}</option>`).join(''):'<option value="">No saved Discovery configurations</option>';if(configurations.some(record=>record.configurationId===previous))select.value=previous;reference();button.disabled=!configurations.length;
  },invalidate(){configurationFingerprint='';clear();select.replaceChildren();reference();button.disabled=true;}};
}
