// Disclosure selection changes only this authenticated logical session.
(() => {
  const panel = document.createElement('section');
  panel.className = 'card'; panel.id = 'session-context-panel'; panel.hidden = true;
  panel.innerHTML = '<h2>Session disclosure</h2><p>Choose whether this session may use your approved relationship context. This does not identify nearby people, start a microphone, play audio or grant tools.</p><label for="session-audience">Audience<select id="session-audience"><option value="unknown">Unknown / shared — withhold private context</option><option value="authenticatedSession">My authenticated session — allow approved context</option></select></label><div class="actions"><button id="session-context-apply" type="button">Apply Session Disclosure</button><button id="session-context-refresh" type="button" class="secondary">Refresh Session State</button></div><p id="session-context-status" role="status"></p><details><summary>Runtime self-context and limitations</summary><pre id="session-context-details" class="context-inspector"></pre></details>';
  document.querySelector('#authentication-panel')?.after(panel);
  const get = id => panel.querySelector('#' + id);
  let revision = null, epoch = 0;
  const render = value => {
    revision = value.revision;
    get('session-audience').value = value.endpoint?.privacyClass === 'personal' ? 'authenticatedSession' : 'unknown';
    get('session-context-status').textContent = `Session revision ${revision} · ${value.endpoint?.privacyClass === 'personal' ? 'Approved context allowed in this authenticated session' : 'Unknown audience: private context withheld'}. Physical speaker identity remains unverified.`;
    get('session-context-details').textContent = JSON.stringify({ runtimeSelfContext: value.runtimeSelfContext, limitations: value.limitations }, null, 2);
  };
  const refresh = async () => {
    const ticket = epoch, value = await window.lifestreamAuth.request('/api/runtime/v1/session-context');
    if (ticket === epoch) render(value);
  };
  const run = fn => async () => { try { await fn(); } catch (error) { revision = null; get('session-context-status').textContent = `${error.message} Refresh session state before applying again.`; } };
  get('session-context-refresh').onclick = run(refresh);
  get('session-context-apply').onclick = run(async () => {
    if (revision === null) throw new Error('Current session state is unavailable.');
    const ticket = epoch;
    const value = await window.lifestreamAuth.request('/api/runtime/v1/session-context', { expectedRevision: revision, mode: 'text', audienceScope: get('session-audience').value }, true);
    if (ticket !== epoch) return;
    render(value);
    window.dispatchEvent(new CustomEvent('lifestream-session-context'));
  });
  const authChanged = () => {
    epoch++; revision = null;
    get('session-context-details').textContent = ''; get('session-context-status').textContent = '';
    panel.hidden = window.lifestreamAuth.mode !== 'local-password' || !window.lifestreamAuth.session;
    if (!panel.hidden) void run(refresh)();
  };
  window.addEventListener('lifestream-auth', authChanged);
  void window.lifestreamAuth.ready.then(authChanged);
})();
