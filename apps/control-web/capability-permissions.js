/* Canonical authority only. Browser input never becomes a grant or dispatch receipt. */
(() => {
  const S = window.lifestreamSecurity, { el, fields, table } = S, $ = id => document.getElementById(id);
  const root = '/api/authority/v1', classes = { allowOnce: 'One use', allowSession: 'This session, until expiry', allowPersistent: 'Persistent, until expiry or revocation' };
  let catalogExpiresAt = 0, tools = [], readers = [], pending = null, version = 0, timer = null;
  const lists = { requests: { rows: [], cursor: null }, grants: { rows: [], cursor: null } };
  const status = text => { $('cap-status').textContent = text; };
  const path = invocationId => `${S.base()}/tools/invocations/${encodeURIComponent(invocationId)}`;
  const envelope = payload => ({ schemaVersion: '1.0.0', requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), payload });
  const show = key => { for (const p of document.querySelectorAll('[data-cap-panel]')) p.hidden = p.dataset.capPanel !== key; for (const b of document.querySelectorAll('[data-cap-view]')) b.setAttribute('aria-pressed', String(b.dataset.capView === key)); };
  for (const b of document.querySelectorAll('[data-cap-view]')) b.onclick = () => show(b.dataset.capView);
  $('cap-disclosure').onclick = () => { $('security-context').open = true; $('session-audience').focus(); };
  const run = fn => async event => { event?.preventDefault(); const ticket = S.epoch(); try { await fn(); } catch (error) { if (ticket === S.epoch()) status(error.message); } };
  const button = (parent, label, fn) => { const b = el('button', label, 'secondary'); b.type = 'button'; b.onclick = run(fn); parent.append(b); return b; };
  const disclosure = (parent, title, value) => { const d = el('details'); d.append(el('summary',title), fields(value)); parent.append(d); };
  const heading = (parent, title) => { const h = el('h3',title); h.tabIndex = -1; parent.append(h); return h; };
  const resetDetails = () => { version++; clearTimeout(timer); for(const kind of ['requests','grants']) { $('cap-'+kind).hidden=false; $('cap-'+kind+'-more').hidden=!lists[kind].cursor; } for (const id of ['cap-request-detail','cap-grant-detail']) { $(id).hidden = true; $(id).replaceChildren(); } };
  const clear = () => {
    resetDetails(); catalogExpiresAt = 0; tools = []; readers = []; pending = null;
    for (const kind of ['requests','grants']) { lists[kind] = { rows: [], cursor: null }; $('cap-' + kind).replaceChildren(); $('cap-' + kind + '-more').hidden = true; $('cap-'+kind+'-state').value=''; }
    $('cap-grants-class').value='';
    $('cap-select').replaceChildren(new Option('Load capabilities first','')); $('cap-arguments').replaceChildren(); $('cap-provider').textContent = '';
    $('cap-form').inert = false; $('cap-prepare').disabled = true; $('cap-prepare-retry').hidden = true; $('cap-class').value = 'allowOnce'; $('cap-review-label').hidden = true;
    status('Context changed. Load capabilities or refresh records for the Current Assistant.');
  };
  window.addEventListener('lifestream-security-context',clear);
  const argumentsForm = () => {
    pending = null; $('cap-form').inert = false; $('cap-prepare-retry').hidden = true; readers = []; $('cap-arguments').replaceChildren();
    const tool = tools[Number($('cap-select').value)]; $('cap-prepare').disabled = !tool;
    if (!tool || $('cap-select').value === '') { $('cap-prepare').disabled = true; return; }
    const schema = tool.inputSchema;
    if (schema.type === 'object' && schema.properties && Object.keys(schema.properties).length <= 32) {
      for (const [key, spec] of Object.entries(schema.properties)) {
        const label = el('label', spec.title || key), required = schema.required?.includes(key);
        let input;
        if (Array.isArray(spec.enum)) { input = el('select'); spec.enum.forEach((value, index) => input.append(new Option(String(value),String(index)))); }
        else if (spec.type === 'boolean') { input = el('select'); input.append(new Option('False','false'),new Option('True','true')); }
        else if (['number','integer'].includes(spec.type)) { input = el('input'); input.type = 'number'; input.step = spec.type === 'integer' ? '1' : 'any'; if (spec.minimum !== undefined) input.min = spec.minimum; if (spec.maximum !== undefined) input.max = spec.maximum; }
        else if (spec.type === 'string') { input = el('input'); input.type = 'text'; if (spec.minLength) input.minLength = spec.minLength; }
        else { input = el('textarea'); input.rows = 3; label.append(el('span',' (JSON value)')); }
        input.dataset.argument = key; input.required = !!required; label.append(input); $('cap-arguments').append(label);
        readers.push(() => {
          if (!required && input.value === '') return null;
          let value = spec.enum ? spec.enum[Number(input.value)] : spec.type === 'boolean' ? input.value === 'true' : ['number','integer'].includes(spec.type) ? Number(input.value) : spec.type === 'string' ? input.value : JSON.parse(input.value);
          if (spec.type === 'string' && spec.maxLength !== undefined && [...value].length > spec.maxLength) throw new Error(`${key} allows at most ${spec.maxLength} characters.`);
          return [key,value];
        });
        if (spec.description) label.append(el('small',spec.description));
      }
    } else {
      const label = el('label','Capability arguments (JSON)'), input = el('textarea'); input.required = true; input.rows = 6; label.append(input); $('cap-arguments').append(label);
      readers = [() => JSON.parse(input.value)]; readers.raw = true;
    }
    disclosure($('cap-arguments'),'Input schema', { Schema: schema });
  };
  $('cap-select').onchange = argumentsForm;
  $('cap-class').onchange = () => { $('cap-review-label').hidden = $('cap-class').value !== 'allowPersistent'; };
  $('cap-refresh').onclick = run(async () => {
    $('cap-refresh').disabled = true; tools = []; argumentsForm(); status('Loading the selected provider’s capabilities…');
    try { const result = await S.request(`${S.base()}/tools`); if (result.protocol !== 'canonical' || result.status !== 'available') throw new Error('Canonical capabilities are unavailable for this selected provider.');
      tools = result.tools; catalogExpiresAt = Date.parse(result.expiresAt); $('cap-provider').textContent = `Provider: ${result.providerRef} · Environment: ${result.environmentId}`;
      $('cap-select').replaceChildren(new Option('Choose a capability','')); tools.forEach((t,i) => $('cap-select').append(new Option(`${t.capabilityId} · ${t.version}`,String(i))));
      status(tools.length ? 'Choose a capability and enter the exact action arguments.' : 'No capabilities are available in this scope.');
    } finally { $('cap-refresh').disabled = false; }
  });
  const prepare = async () => {
    if (!pending) return; const selected = pending; $('cap-form').inert = true; $('cap-prepare-retry').hidden = true; $('cap-prepare').disabled = true;
    status('Preparing the exact action. No permission has been granted.');
    try {
      if (!selected.prepared) { const p = await S.request(selected.path,selected.body); if (selected !== pending) return; selected.prepared = p.preparation; }
      if (!selected.command) { const { environmentId: _environment, sideEffectClass: _effect, ...payload } = selected.prepared.request; selected.command = envelope(payload); }
      const created = await S.request(root + '/requests',selected.command); if (selected !== pending) return; pending = null;
      show('requests'); await loadRequests(); await selectRequest(created.result.requestId);
      status('Pending request recorded. Review its exact effect, arguments and permission terms below.');
    } catch (error) {
      if (selected !== pending) return;
      const uncertain = !error.status || error.status >= 500;
      $('cap-prepare-retry').hidden = !uncertain;
      if (!uncertain) pending = null;
      status(`${error.message} ${uncertain ? 'The outcome is unconfirmed. Retry the same preparation or refresh requests; the original keys are retained.' : 'Edit and prepare again; nothing has been approved.'}`);
    } finally { if (selected === pending || pending === null) { $('cap-form').inert = !!pending; $('cap-prepare').disabled = !!pending || !tools.length; } }
  };
  $('cap-form').onsubmit = run(async () => {
    if (pending) throw new Error('Resolve the existing preparation first using its retry control.');
    const tool = tools[Number($('cap-select').value)]; if (!tool || $('cap-select').value === '') throw new Error('Choose a capability first.');
    if (!Number.isFinite(catalogExpiresAt) || catalogExpiresAt <= Date.now() + 5000) throw new Error('The capability catalog has expired. Load available capabilities and review the current definition again.');
    const duration = Number($('cap-duration').value), review = Number($('cap-review').value), grantClass = $('cap-class').value, now = Date.now();
    if (grantClass === 'allowPersistent' && (review < 1 || review > duration)) throw new Error('The review boundary must be within the permission duration.');
    const input = readers.raw ? readers[0]() : Object.fromEntries(readers.map(read => read()).filter(Boolean));
    pending = { path: `${S.base()}/tools/${encodeURIComponent(tool.capabilityId)}/prepare`, body: { idempotencyKey: crypto.randomUUID(), capabilityVersion: tool.version, input, requestedClass: grantClass, grantExpiresAt: new Date(now + duration * 60000).toISOString(), reviewAfter: grantClass === 'allowPersistent' ? new Date(now + review * 60000).toISOString() : null, expiresAt: new Date(Math.min(now + 90000,catalogExpiresAt - 1000)).toISOString(), untrustedRationale: null } };
    await prepare();
  });
  $('cap-prepare-retry').onclick = run(prepare);
  const recordRows = kind => {
    $('cap-' + kind + '-more').hidden = !lists[kind].cursor;
    const rows = lists[kind].rows.filter(item => kind !== 'grants' || !$('cap-grants-class').value || item.grant.grantClass === $('cap-grants-class').value);
    if (!rows.length) { $('cap-' + kind).replaceChildren(el('p',`No ${kind} found for this Assistant. ${kind === 'requests' ? 'Prepare an action to begin.' : 'A grant appears only after an approved request.'}`)); return; }
    $('cap-' + kind).replaceChildren(table(['Record ID','Capability','State / eligibility','Duration','Expiry'], rows.map(item => {
      const r = kind === 'requests' ? item : item.grant, id = r.requestId || r.grantId, b = el('button',id); b.type = 'button'; b.onclick = run(() => kind === 'requests' ? selectRequest(id) : selectGrant(id));
      return [b,r.scope.capabilityId,kind === 'requests' ? `${r.state} · revision ${r.revision}` : `${r.status} · ${item.eligible ? 'Eligible' : item.reason.summary} · revision ${r.revision}`,classes[r.requestedClass || r.grantClass],r.grantExpiresAt || r.expiresAt];
    })));
    $('cap-' + kind + '-more').hidden = !lists[kind].cursor;
  };
  const loadList = async (kind, more = false) => {
    const selected = lists[kind], cursor = more ? selected.cursor : null, requestNo=(selected.requestNo||0)+1; selected.requestNo=requestNo;
    const value = await S.request(`${root}/${kind}?assistantId=${encodeURIComponent(S.assistant())}&limit=20${$('cap-'+kind+'-state').value ? '&states='+encodeURIComponent($('cap-'+kind+'-state').value) : ''}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    if (selected !== lists[kind] || selected.requestNo!==requestNo) return;
    selected.rows = more ? [...selected.rows,...value.result[kind]] : value.result[kind]; selected.cursor = value.result.nextCursor; recordRows(kind);
  };
  const loadRequests = () => loadList('requests');
  $('cap-grants-class').onchange = () => { resetDetails(); recordRows('grants'); };
  for(const kind of ['requests','grants']) $('cap-'+kind+'-state').onchange=run(async () => { resetDetails(); await loadList(kind); });
  for (const kind of ['requests','grants']) {
    $('cap-' + kind + '-refresh').onclick = run(async () => { resetDetails(); await loadList(kind); status(`Current ${kind} loaded. Select a record to inspect it.`); });
    $('cap-' + kind + '-more').onclick = run(() => loadList(kind,true));
  }
  const action = (parent, label, url, command, done, confirmation) => {
    const myVersion = version; let busy = false;
    const b = button(parent,label,async () => {
      if (busy || myVersion !== version || confirmation && !confirmation.checked) return;
      busy = true; b.disabled = true;
      try { const result = await S.request(url,command); if (myVersion === version) await done(result); }
      catch (error) { if (myVersion !== version) return; const uncertain = !error.status || error.status >= 500;
        status(`${error.message} ${uncertain ? 'Outcome unconfirmed. The same command is retained; refresh the original record or retry this exact command.' : 'This review is no longer actionable. Refresh and review the current record.'}`);
        if (uncertain) { b.textContent = 'Retry same command: ' + label; b.disabled = false; } else { b.disabled = true; if (confirmation) { confirmation.checked = false; confirmation.disabled = true; } }
      } finally { busy = false; }
    });
    if (/^(Approve|Run approved)/.test(label)) b.className='';
    if (confirmation) { b.disabled = true; confirmation.onchange = () => { b.disabled = !confirmation.checked || busy || myVersion !== version; }; }
    return b;
  };
  const requestDetails = (parent,r) => {
    parent.append(fields({ 'Request ID':r.requestId, 'State / revision':`${r.state} · ${r.revision}`, Effect:r.effectSummary, 'Effect class':r.sideEffectClass, Capability:r.scope.capabilityId, Operation:r.scope.operation, Targets:r.scope.targetRefs, 'Data scope':r.scope.dataScopeRefs, Permission:classes[r.requestedClass], 'Permission expiry':r.grantExpiresAt, 'Review required':r.reviewAfter, 'Request expiry':r.expiresAt, Environment:r.environmentId },true));
    disclosure(parent,'Identity and proof references', { Assistant:r.assistantId, Endpoint:r.endpointId, Session:r.sessionId, Invocation:r.invocationId, 'Input digest':r.inputDigest, 'Confirmation digest':r.confirmationDigest, Interaction:r.interactionTraceId });
    if (r.untrustedRationale) parent.append(el('h4','Untrusted request rationale'),el('p',r.untrustedRationale));
  };
  async function selectRequest(id) {
    resetDetails(); const ticket = version, r = (await S.request(`${root}/requests/${encodeURIComponent(id)}`)).result;
    if (ticket !== version) return; show('requests'); const panel = $('cap-request-detail'); panel.hidden = false; $('cap-requests').hidden=true; $('cap-requests-more').hidden=true; button(panel,'Back to request list',() => { resetDetails(); $('cap-requests-refresh').focus(); }); const h = heading(panel,'2. Review this request'); requestDetails(panel,r); h.focus();
    let retained;
    try { retained = await S.request(path(r.invocationId) + '/preparation'); }
    catch (error) { if (ticket === version) panel.append(el('p',`Exact prepared arguments unavailable: ${error.message}. Approval and dispatch are withheld.`)); }
    if (ticket !== version) return;
    if (retained) { panel.append(el('h4','Exact action arguments'),fields(retained.input && typeof retained.input === 'object' && !Array.isArray(retained.input) ? retained.input : { Value:retained.input })); disclosure(panel,'Exact typed input',{Input:retained.input}); }
    const actions = el('div',undefined,'actions'); panel.append(actions);
    if (r.state === 'pending') {
      if (retained && Date.parse(r.expiresAt) > Date.now()) {
        const label = el('label',undefined,'security-confirm'), check = el('input'); check.type = 'checkbox'; label.append(check,el('span','I reviewed these exact targets, arguments, effect and permission terms.')); panel.insertBefore(label,actions);
        const approveLabel = r.requestedClass === 'allowOnce' ? 'Approve once' : r.requestedClass === 'allowSession' ? 'Approve for this session' : `Approve until ${r.grantExpiresAt}`;
        const approve = action(actions,approveLabel,`${root}/requests/${r.requestId}/approve`,envelope({ requestId:r.requestId, expectedRevision:r.revision, confirmationDigest:r.confirmationDigest, grantClass:r.requestedClass, expiresAt:r.grantExpiresAt, reviewAfter:r.reviewAfter }),async result => { await selectGrant(result.result.grant.grantId,retained); status('Permission granted. The action has not been run. Review the grant and choose Run approved action.'); },check);
        timer = setTimeout(() => { if (ticket === version) { approve.disabled = true; check.disabled = true; check.checked = false; status('This request has expired. Prepare a fresh action and review again.'); } },Math.max(0,Date.parse(r.expiresAt) - Date.now()));
      } else panel.append(el('p','Approval unavailable. The request may have expired or its prepared context is inaccessible.'));
      for (const decision of ['deny','cancel']) action(actions,decision === 'deny' ? 'Deny request' : 'Cancel request',`${root}/requests/${r.requestId}/${decision}`,envelope({ requestId:r.requestId, expectedRevision:r.revision, confirmationDigest:r.confirmationDigest, reason:{ code:`human_${decision}`,summary:`Human chose to ${decision} this request.` } }),async () => { await selectRequest(r.requestId); status(`Request ${decision === 'deny' ? 'denied' : 'cancelled'} by the server.`); });
    }
    if (r.grantId) button(actions,'Inspect recorded grant',() => selectGrant(r.grantId,retained));
    if (r.state === 'pending' && retained) button(actions,'Check existing reusable permissions',async () => {
      const result = await S.request(`${root}/grants?assistantId=${encodeURIComponent(S.assistant())}&limit=100`);
      if (ticket !== version) return;
      const candidates = result.result.grants.filter(v => v.eligible && v.grant.grantClass !== 'allowOnce' && v.grant.scope.capabilityId === r.scope.capabilityId);
      const choices = el('section'); choices.append(el('h4','Existing permissions to review'),el('p','These permissions may cover this action. Review the selected permission and exact arguments; the server independently checks the full scope before dispatch.'));
      if (!candidates.length) choices.append(el('p','No eligible reusable permissions in this page.'));
      for (const {grant} of candidates) button(choices,`${classes[grant.grantClass]} · ${grant.grantId}`,() => selectGrant(grant.grantId,retained));
      if (result.result.nextCursor) choices.append(el('p','More grants exist. Use Grants & history to inspect subsequent pages.'));
      panel.append(choices);
    });
  }
  async function selectGrant(id, retained) {
    resetDetails(); const ticket = version, view = (await S.request(`${root}/grants/${encodeURIComponent(id)}`)).result;
    if (ticket !== version) return; const g = view.grant; show('grants'); const panel = $('cap-grant-detail'); panel.hidden = false; $('cap-grants').hidden=true; $('cap-grants-more').hidden=true; button(panel,'Back to grant list',() => { resetDetails(); $('cap-grants-refresh').focus(); }); const h = heading(panel,'3. Permission and action result');
    panel.append(fields({ 'Grant ID':g.grantId, 'Stored state / revision':`${g.status} · ${g.revision}`, 'Current eligibility':view.eligible ? 'Eligible; final authorization still required' : view.reason.summary, Permission:classes[g.grantClass], Capability:g.scope.capabilityId, Operation:g.scope.operation, Targets:g.scope.targetRefs, 'Data scope':g.scope.dataScopeRefs, Expiry:g.expiresAt, 'Review required':g.reviewAfter, Environment:g.environmentId },true)); h.focus();
    disclosure(panel,'Grant identity and history', { Assistant:g.assistantId, Endpoint:g.endpointId, Session:g.sessionId, Issuer:g.principalId, 'Source request':g.grantRequestId, 'Source revision':view.sourceRevision, Events:view.events, 'Admitted invocation IDs':view.admittedInvocationIds });
    const actions = el('div',undefined,'actions'); panel.append(actions);
    if (g.status === 'active') {
      const label = el('label',undefined,'security-confirm'), check = el('input'); check.type='checkbox'; label.append(check,el('span','Revoke future admissions. This does not undo an already-admitted effect.')); panel.append(label);
      action(actions,'Revoke permission',`${root}/grants/${g.grantId}/revoke`,envelope({grantId:g.grantId,expectedRevision:g.revision,reason:{code:'human_revoke',summary:'Human revoked future admissions.'}}),async () => { await selectGrant(g.grantId); status('Revocation recorded. Already-admitted effects are not undone.'); },check);
    }
    const resultPanel = el('section',undefined,'security-outcome'); panel.append(resultPanel);
    try {
      if (!retained) { const r = (await S.request(`${root}/requests/${g.grantRequestId}`)).result; retained = await S.request(path(r.invocationId) + '/preparation'); }
      if (ticket !== version) return;
      const p = retained.preparation.request, target = path(p.invocationId);
      if (p.assistantId !== S.assistant()) throw new Error('Prepared Assistant changed.');
      resultPanel.append(el('h4','Prepared action for this permission'),fields({ 'Invocation ID':p.invocationId, Effect:p.effectSummary, Arguments:retained.input }));
      if (view.eligible) action(resultPanel,'Run approved action',target+'/dispatch',{grantId:g.grantId,idempotencyKey:retained.idempotencyKey},async result => { renderResult(resultPanel,result,target); status('Dispatch response received. Read the actual action result below.'); });
      button(resultPanel,'Read original result',async () => { const result = await S.request(target); if (ticket === version) renderResult(resultPanel,result,target); });
      if (g.grantClass !== 'allowOnce') {
        const reuse = el('p','A reusable grant may cover a fresh matching action. Preparing a new action never repeats this invocation.'); resultPanel.append(reuse);
        // A newly prepared action is explicitly chosen; the host checks its full scope at dispatch.
        button(resultPanel,'Prepare another action',() => { show('prepare'); $('cap-select').focus(); });
      }
      for (const invocation of view.admittedInvocationIds || []) if (invocation !== p.invocationId) button(resultPanel,`Read admitted invocation ${invocation}`,async () => { const target = path(invocation), result = await S.request(target); if (ticket === version) renderResult(resultPanel,result,target); });
    } catch (error) { if (ticket === version) resultPanel.append(el('p',`Original action unavailable: ${error.message}. No action was submitted.`)); }
  }
  function renderResult(parent,result,target) {
    let panel = parent.querySelector('[data-action-result]'); if (!panel) { panel=el('section'); panel.dataset.actionResult=''; parent.append(panel); }
    panel.replaceChildren(); const h=heading(panel,'Observed action result');
    const observed=result.latestObservation?.result || result.result, payload=observed?.outcome?.payload;
    panel.append(fields({ Status:result.status, 'Original response reused':result.replayed === undefined ? 'Not specified' : String(result.replayed), 'Provider outcome':payload?.type || observed?.outcome?.status || 'Unconfirmed', Output:payload?.output, Reason:payload?.reason || result.reason || result.error }));
    disclosure(panel,'Receipt and result detail',{Result:result});
    if (!['succeeded','failed'].includes(result.status)) action(panel,'Check original result with provider',target+'/reconcile',{},async next => renderResult(parent,next,target));
    h.focus();
  }
})();
