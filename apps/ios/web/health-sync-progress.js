// Only the display preference survives a session. Counts stay in memory.
export function createHealthSyncProgress({panel, label, bar, toggle, snapshot, storage}) {
  const key = 'lifestream.showHealthSyncProgress';
  let allowed = false, revision = 0, timer;
  try {
    storage ??= window.localStorage;
    toggle.checked = storage.getItem(key) !== 'off';
  } catch { toggle.checked = true; }

  function clear() {
    clearTimeout(timer);
    panel.hidden = true;
    label.textContent = '';
    bar.removeAttribute('value');
  }

  function update(value) {
    revision++;
    clear();
    if (!allowed || !toggle.checked) return;
    if (value?.phase === 'reading') {
      label.textContent = 'Reading health records…';
    } else {
      const {phase, confirmed, total} = value ?? {};
      if (!['syncing', 'finished'].includes(phase) || !Number.isSafeInteger(total) || total <= 0 ||
          !Number.isSafeInteger(confirmed) || confirmed < 0 || confirmed > total) return;
      label.textContent = `Health records ${confirmed} / ${total}`;
      bar.max = total;
      bar.value = confirmed;
      if (phase === 'finished') timer = setTimeout(clear, 1800);
    }
    panel.hidden = false;
  }

  function refresh() {
    const ticket = ++revision;
    clear();
    if (allowed && toggle.checked) {
      void snapshot().then(value => {
        if (ticket === revision) update(value.healthSyncProgress);
      }).catch(() => {});
    }
  }

  toggle.onchange = () => {
    try { storage.setItem(key, toggle.checked ? 'on' : 'off'); } catch { /* Use the preference for this launch. */ }
    refresh();
  };
  return {update, setPrivate(value) {
    if (allowed === value) return;
    allowed = value;
    refresh();
  }};
}
