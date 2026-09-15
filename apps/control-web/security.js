(() => {
  const $ = id => document.getElementById(id), auth = window.lifestreamAuth;
  const status = text => { $('security-status').textContent = text; };
  let epoch = 0, editingSkill = null, review = null;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const request = async (path, body) => {
    const ticket = epoch; await auth.ready;
    if (ticket !== epoch) throw new Error('Context changed. Review again.');
    const result = await auth.request(path, body, body !== undefined);
    if (ticket !== epoch) throw new Error('Context changed. Previous response discarded.');
    return result;
  };
  const assistant = () => { const id = $('security-assistant').value; if (!id) throw new Error('Choose a Current Assistant first.'); return id; };
  const base = () => `/api/authority/v1/assistants/${encodeURIComponent(assistant())}`;
  const run = fn => async event => {
    event?.preventDefault(); const ticket = epoch, control = event?.currentTarget;
    if (control?.tagName === 'BUTTON') control.disabled = true;
    try { await fn(); } catch (error) { if (ticket === epoch) status(error.message); }
    finally { if (control?.tagName === 'BUTTON' && control.id !== 'security-approve-proposal') control.disabled = false; }
  };
  const button = (parent, text, fn) => { const b = el('button', text); b.type = 'button'; b.onclick = run(fn); parent.append(b); return b; };
  const display = (value, formatDate = false) => {
    if (value === null || value === undefined || Array.isArray(value) && value.length === 0) return 'None';
    if (Array.isArray(value) && value.every(v => typeof v !== 'object')) return value.join('\n');
    if (formatDate && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'long'}).format(new Date(value));
    return typeof value === 'object' ? JSON.stringify(value,null,2) : String(value);
  };
  const fields = (values, formatDates = false) => { const dl = el('dl',undefined,'security-fields'); for (const [name,value] of Object.entries(values)) { const dd=el('dd',display(value,formatDates)); if(typeof value==='string') dd.title=value; dl.append(el('dt',name),dd); } return dl; };
  const table = (headers, rows) => { const table = el('table', undefined, 'security-table'), head = el('thead'), tr = el('tr'), body = el('tbody'); headers.forEach(name => { const th = el('th', name); th.scope = 'col'; tr.append(th); }); head.append(tr); table.append(head, body); for (const row of rows) { const r = el('tr'); row.forEach((value, i) => { const td = el('td'); td.dataset.label = headers[i]; if (value instanceof Node) td.append(value); else { td.textContent = display(value,headers[i]==='Expiry'); if(typeof value==='string') td.title=value; } r.append(td); }); body.append(r); } return table; };
  const clear = () => {
    epoch++; editingSkill = null; review = null;
    for (const id of ['security-proposal','security-account-list','security-skills']) $(id).replaceChildren();
    for (const id of ['security-password','security-principal','security-skill','security-proposal-id']) $(id).value = '';
    $('security-approve-proposal').disabled = true; status('');
    $('security-assistant-id').textContent = $('security-assistant').value;
    window.dispatchEvent(new CustomEvent('lifestream-security-context'));
  };
  const loadAssistants = async () => {
    const previous = $('security-assistant').value, value = await request('/api/admin/v1/assistants');
    $('security-assistant').replaceChildren(new Option('Choose an Assistant', ''));
    for (const a of value.assistants) $('security-assistant').append(new Option(a.displayName || a.activeProfile?.displayName || a.profiles?.at(-1)?.displayName || a.assistantId, a.assistantId));
    if (value.assistants.some(a => a.assistantId === previous)) $('security-assistant').value = previous;
    else clear();
  };
  $('security-assistant').onchange = clear; $('security-reload-assistants').onclick = run(loadAssistants);
  const view = () => { const key = location.hash.slice(1), active = ['capabilities','people','skills','proposals'].includes(key) ? key : 'capabilities'; for (const p of document.querySelectorAll('[data-security-panel]')) p.hidden = p.dataset.securityPanel !== active; for (const a of document.querySelectorAll('[data-security-view]')) { const selected = a.dataset.securityView === active; if (selected) { a.setAttribute('aria-current','page'); $('security-heading').textContent = a.textContent; } else a.removeAttribute('aria-current'); } };
  window.addEventListener('hashchange', () => { view(); $('security-heading').focus(); });
  for (const a of document.querySelectorAll('[data-security-view]')) a.onclick = event => { event.preventDefault(); location.hash = a.dataset.securityView; if(matchMedia('(max-width:760px)').matches) $('security-navigation').open=false; view(); $('security-heading').focus(); };
  view();
  $('security-provision').onclick = run(async () => { const body = { username: $('security-username').value, password: $('security-password').value }; $('security-password').value = ''; const result = await request('/api/auth/v1/accounts', body); $('security-principal').value = result.principalId; status('Account created with no Assistant permissions.'); });
  $('security-accounts').onclick = run(async () => { const { accounts } = await request('/api/auth/v1/accounts'); $('security-account-list').replaceChildren(accounts.length ? table(['Account','Principal ID','Role'], accounts.map(a => [a.username, a.principalId, a.owner ? 'Owner' : 'Member'])) : el('p','No accounts available.')); });
  for (const [id, administer] of [['security-grant-scope',true],['security-revoke-scope',false]]) $(id).onclick = run(async () => { await request('/api/auth/v1/permissions', { principalId: $('security-principal').value, assistantId: assistant(), administer }); status('Assistant administration scope updated. Relationship access remains subject-owned.'); });
  const refreshSkills = async () => {
    const result = await request(`${base()}/skills`); $('security-skills').replaceChildren();
    if (!result.skills.length) $('security-skills').append(el('p','No Skill revisions. Save a draft to begin.'));
    for (const skill of result.skills) { const row = el('section', undefined, 'card'); row.append(el('h4', `${skill.name} · revision ${skill.revision} · ${skill.status}`), fields({ 'Skill ID': skill.skillId, Version: skill.version, Description: skill.description }));
      button(row,'Edit as new draft',async () => { editingSkill = { id: skill.skillId, revision: skill.revision }; $('security-skill').value = JSON.stringify({ ...skill, status: 'draft', activationRef: null }, null, 2); $('security-skill').focus(); status('Editing an inert draft. The active Skill remains unchanged until activation.'); });
      if (skill.status === 'draft') button(row,'Activate reviewed Skill', async () => { await request(`${base()}/skills/${skill.skillId}/activate`, { expectedRevision: skill.revision }); await refreshSkills(); });
      button(row,'Show revision history',async () => { const pre = el('pre', JSON.stringify(await request(`${base()}/skills/${skill.skillId}/history`), null, 2)); row.append(pre); }); $('security-skills').append(row);
    }
  };
  $('security-save-skill').onclick = run(async () => { const draft = JSON.parse($('security-skill').value); await request(editingSkill ? `${base()}/skills/${editingSkill.id}/revisions` : `${base()}/skills`, { skill: draft, ...(editingSkill ? { expectedRevision: editingSkill.revision } : {}) }); editingSkill = null; await refreshSkills(); status('Inert Skill draft saved; activation and tool authority are separate.'); });
  $('security-refresh-skills').onclick = run(refreshSkills);
  $('security-review-proposal').onclick = run(async () => { review = null; $('security-approve-proposal').disabled = true; const id = $('security-proposal-id').value, result = await request(`/api/auth/v1/proposals/${encodeURIComponent(id)}`); review = { id, digest: result.digest }; $('security-proposal').textContent = JSON.stringify(result.operation, null, 2); $('security-approve-proposal').disabled = result.status !== 'proposed'; });
  $('security-approve-proposal').onclick = run(async () => { if (!review) return; const selected = review; review = null; $('security-approve-proposal').disabled = true; await request(`/api/auth/v1/proposals/${encodeURIComponent(selected.id)}/approve`, { reviewedDigest: selected.digest, humanConfirmed: true }); status('The reviewed operation was submitted once through its normal validation and scope checks.'); });
  $('security-context-panels').append($('authentication-panel'), $('session-context-panel'));
  const mobile = matchMedia('(max-width:760px)'); const navigationSize = () => { $('security-navigation').open=!mobile.matches; }; mobile.addEventListener('change',navigationSize); navigationSize();
  const authChanged = () => {
    clear(); $('security-assistant').replaceChildren(new Option('Choose an Assistant','')); $('security-assistant-id').textContent = '';
    $('security-context').open = !auth.session;
    $('security-identity').textContent = auth.session ? ` · ${auth.session.owner ? 'Owner' : 'Member'} · ${auth.session.principalId}` : ' · Sign in required';
    if (auth.session) void run(loadAssistants)();
  };
  window.lifestreamSecurity = { request, assistant, base, el, fields, table, epoch: () => epoch };
  window.addEventListener('lifestream-auth',authChanged); window.addEventListener('lifestream-session-context',clear);
  void auth.ready.then(authChanged);
})();
