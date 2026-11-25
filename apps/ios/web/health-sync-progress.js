const categoryLabels = new Map([
  ['sleep', 'Sleep'], ['heartRate', 'Heart rate'], ['restingHeartRate', 'Resting heart rate'],
  ['respiratoryRate', 'Respiratory rate'], ['hrvSDNN', 'Heart rate variability']
]);

// Only the display preference survives a session. Counts stay in memory.
export function createHealthSyncProgress({panel, label, bar, toggle, snapshot, storage}) {
  const key = 'lifestream.showHealthSyncProgress';
  let view = null, revision = 0, timer;
  try {
    storage ??= window.localStorage;
    toggle.checked = storage.getItem(key) !== 'off';
  } catch { toggle.checked = true; }

  function clear() {
    clearTimeout(timer);
    panel.hidden = true;
    label.textContent = '';
    bar.removeAttribute('value');
    bar.removeAttribute('max');
    bar.hidden = true;
  }

  function settingsStatus(message) {
    if (view === 'settings' && toggle.checked) {
      label.textContent = message;
      panel.hidden = false;
    }
  }

  function update(value) {
    revision++;
    clear();
    if (!view || !toggle.checked) return;
    if (value?.phase === 'idle') {
      settingsStatus('No active transfer reported.');
      return;
    } else if (value?.phase === 'reading') {
      label.textContent = 'Reading health records…';
    } else if (value?.phase === 'preparing') {
      label.textContent = 'Preparing health records…';
    } else {
      const {phase, confirmed, total} = value ?? {};
      if (!['syncing', 'finished'].includes(phase) || !Number.isSafeInteger(total) || total <= 0 ||
          !Number.isSafeInteger(confirmed) || confirmed < 0 || confirmed > total) {
        settingsStatus('Sync activity is unavailable.');
        return;
      }
      const category = categoryLabels.get(value.category) ?? 'Health';
      if (confirmed === 0 && phase === 'syncing') {
        label.textContent = `${category} · Sending from ${total.toLocaleString()} queued`;
      } else {
        label.textContent = `${category} · ${confirmed.toLocaleString()} of ${total.toLocaleString()} confirmed this pass`;
        bar.max = total;
        bar.value = confirmed;
      }
      if (phase === 'finished') timer = setTimeout(() => {
        clear();
        settingsStatus('Last sync pass finished.');
      }, 1800);
    }
    bar.hidden = false;
    panel.hidden = false;
  }

  function refresh() {
    const ticket = ++revision;
    clear();
    if (view && toggle.checked) {
      settingsStatus('Checking sync activity…');
      void snapshot().then(value => {
        if (ticket === revision) update(value?.healthSyncProgress);
      }).catch(() => {
        if (ticket === revision) update(null);
      });
    }
  }

  toggle.onchange = () => {
    try { storage.setItem(key, toggle.checked ? 'on' : 'off'); } catch { /* Use the preference for this launch. */ }
    refresh();
  };
  return {update, setView(next) {
    if (view === next) return;
    view = next;
    refresh();
  }};
}
