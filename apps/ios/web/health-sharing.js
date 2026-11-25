const categories = ['SleepSegment', 'heartRate', 'restingHeartRate', 'respiratoryRate', 'hrvSDNN'];
const day = 86400000;
function requireResult(condition, message) {
  if (!condition) throw Error(message);
}

// The switch covers sync and private answers for the selected Assistant.
async function phoneSource(call) {
  const inventory = await call('healthInventory');
  const mine = inventory.sources.filter(s => s.collector === 'healthKit' && s.currentEnrollmentId);
  requireResult(mine.length <= 1, 'More than one Health source is bound to this phone.');
  return mine[0];
}

async function prepareSource(call) {
  let source = await phoneSource(call);
  // Each write gets a new catalog. If a reply is lost, recover that command
  // before issuing another. A later tap can continue from the saved enrollment.
  for (let step = 0; step < 3; step++) {
    if (source?.currentState === 'active' && !source.collectionPaused && source.categories.length) break;
    let catalog = await call('healthRemoteSetupOptions');
    if (catalog.state === 'held') {
      await call('healthRecoverRemoteSetup');
      catalog = await call('healthRemoteSetupOptions');
    }
    requireResult(catalog.state === 'options' && catalog.enrollments.length <= 1, 'The server could not set up Health sharing for this phone.');
    const enrollment = catalog.enrollments[0];
    let action;
    if (!enrollment) action = {kind:'enroll'};
    else if (!enrollment.bound) action = {kind:'bindSource', enrollmentChoice:enrollment.choice, bindingMode:'createNew'};
    else {
      requireResult(source, 'The server could not identify this phone’s Health source.');
      action = {kind:'configure', enrollmentChoice:enrollment.choice, state:'active', choicesConfirmed:true,
        configuration:{categories:source.categories.length ? source.categories : categories,
          uses:source.uses, assistantIds:source.assistantIds, collectionPaused:false, usePaused:source.usePaused}};
    }
    const review = await call('healthReviewRemoteSetup', {catalogId:catalog.catalogId, ...action});
    requireResult(review.state === 'review' && review.summary?.kind === action.kind && review.summary.destination === catalog.destination,
      'The server could not confirm this phone’s Health settings.');
    let receipt = await call('healthApplyRemoteSetup', {reviewId:review.reviewId, humanConfirmed:true});
    if (receipt.state === 'held') receipt = await call('healthRecoverRemoteSetup');
    requireResult(receipt.state === 'recorded' && receipt.kind === action.kind && receipt.outcome === 'applied' && receipt.currentness === 'current',
      'The server did not confirm Health setup. Turn sharing on to retry.');
    const closed = await call('healthRemoteSetupOptions', {close:true});
    requireResult(closed.reason === 'closed', 'Health setup is still finishing. Try again in a moment.');
    source = await phoneSource(call);
  }
  requireResult(source?.currentState === 'active' && !source.collectionPaused, 'Health collection is paused on the server.');
  return source;
}

function sharingPermission(review, input, purpose) {
  const status = review.statuses?.find(row => row.purpose === purpose);
  requireResult(review.state === 'review' && status && review.source?.sourceNamespace === input.sourceNamespace &&
    review.source.enrollmentId === input.enrollmentId && review.source.category === input.category, 'The server could not verify Health sharing permissions.');
  return status.consentState;
}

async function consent(call, source, category, purpose) {
  const input = {sourceNamespace:source.sourceNamespace, enrollmentId:source.currentEnrollmentId, category};
  let review = await call('healthLoadSourceConsent', input);
  if (review.state === 'held') {
    await call('healthRecoverSourceConsent');
    review = await call('healthLoadSourceConsent', input);
  }
  if (sharingPermission(review, input, purpose) === 'valid') return;
  review = await call('healthRequestSourceConsent', {reviewId:review.reviewId, purpose, validity:{kind:'untilRevoked'},
    reviewDeadlineAt:new Date(Date.now() + 5 * 60000).toISOString()});
  requireResult(review.state === 'review' && review.approvalAvailable === true && review.request?.scope?.purpose === purpose,
    'The server could not approve sharing from this phone.');
  let receipt = await call('healthConfirmSourceConsent', {reviewId:review.reviewId, humanConfirmed:true});
  const needsReceipt = receipt.state === 'held';
  if (needsReceipt) receipt = await call('healthRecoverSourceConsent');
  requireResult(receipt.state === 'recorded' && receipt.decision === 'approved' && receipt.purpose === purpose && receipt.category === category,
    'Couldn’t verify sharing permission. Turn sharing on again to check.');
  if (needsReceipt) {
    const current = await call('healthLoadSourceConsent', input);
    requireResult(sharingPermission(current, input, purpose) === 'valid', 'Sharing permission is no longer active for this phone.');
  }
}

async function assistantSharing(call, context, source, action, category) {
  requireResult(context.assistantId, 'Select your Assistant before sharing Health records.');
  return call('healthAssistantSharing', {action, assistantId:context.assistantId,
    enrollmentId:source.currentEnrollmentId, ...(category ? {category} : {})});
}
async function allowAnswers(call, context, source) {
  if ((await assistantSharing(call,context,source,'status')).enabled) return false;
  for (const category of source.categories) {
    const result = await assistantSharing(call,context,source,'allowCategory',category);
    requireResult(result.approved === true, 'Could not share this Health category with your Assistant.');
  }
  requireResult((await assistantSharing(call,context,source,'enable')).enabled === true,
    'Your Assistant could not confirm access to your Health records.');
  return true;
}

export async function enableHealthSharing(call, context, notify) {
  notify('Choose what to share in Apple Health.');
  const access = await call('healthChooseRecords');
  requireResult(access.completed === true, 'Apple Health could not finish the permission request.');
  notify('Connecting this phone to Lifestream…');
  let choices = await call('healthSetupChoices');
  let source = await prepareSource(call);
  const selected = source.categories.filter(c => categories.includes(c));
  requireResult(selected.length, 'This Health source has no supported record types.');
  if (!choices.choices?.length) {
    for (const category of selected) {
      for (const purpose of ['collection', 'transmission']) await consent(call, source, category, purpose);
      const storage = await call('healthPreparePhoneStorage', {enrollmentId:source.currentEnrollmentId, category});
      requireResult(storage.ready === true, 'The server could not prepare storage for these records.');
    }
  }
  const newlyShared = await allowAnswers(call,context,source);
  try {
    if (newlyShared) {
      // Changing the recipient can revise the source. Retire the previous
      // native configuration before binding the phone to the new revision.
      const fresh = await phoneSource(call);
      requireResult(fresh?.currentEnrollmentId === source.currentEnrollmentId && fresh.sourceNamespace === source.sourceNamespace,
        'The Health source changed during setup.');
      if (fresh.policyRevision !== source.policyRevision || choices.choices?.length) {
        const released = await call('healthReleaseSharingProfile',{enrollmentId:fresh.currentEnrollmentId});
        requireResult(released.ready, 'This phone is finishing its previous Health sync.');
        choices = await call('healthSetupChoices');
      }
      source = fresh;
    }
    await finishPhoneSharing(call,context,choices,source,selected);
  } catch (error) {
    if (newlyShared) await assistantSharing(call,context,source,'disable');
    throw error;
  }
}

async function finishPhoneSharing(call, context, choices, source, selected) {
  if (!choices.choices?.length) {
    const now = Date.now();
    const prepared = await call('healthPrepareExistingSource', {schemaVersion:'1.0.0', sourceNamespace:source.sourceNamespace,
      enrollmentId:source.currentEnrollmentId, endpointId:context.endpointId, contextRevision:context.revision, policyRevision:source.policyRevision,
      categories:selected, rangeStart:new Date(now - 30 * day).toISOString(), rangeEnd:new Date(now).toISOString(),
      localSetup:'shareOnThisPhone'});
    requireResult(prepared.state === 'prepared', 'Lifestream could not prepare this phone to sync.');
    choices = await call('healthSetupChoices');
  }
  requireResult(choices.state === 'available' && choices.choices.length === 1, 'This phone’s Health connection is unavailable.');
  const choice = choices.choices[0], binding = {catalogId:choices.catalogId, choice:choice.choice};
  if (choice.localSetup !== 'configuredLocalConfirmed') {
    const setup = await call('healthSetupChoice', binding);
    requireResult(setup.setupOutcome === 'prepared', 'This phone could not open its Health sync store.');
  }
  const saved = await call('healthRememberedChoice', {...binding, operation:'remember', humanConfirmed:true, updatesEnabled:true});
  requireResult(saved.persistence === 'savedEnabled' && saved.updatesEnabled === true, 'This phone could not save the sharing preference.');

}

export async function stopHealthSharing(call) {
  const saved = await call('healthSavedRecoveryChoice', {operation:'status'});
  requireResult(Array.isArray(saved.choices), 'This phone could not check whether sharing has stopped.');
  const active = saved.choices.filter(c => c.updatesEnabled && !c.requiresRebind);
  const stops = active.map(({choice}) => ({operation:'stop', choice}));
  if (!stops.length && saved.persistence === 'savedEnabled') stops.push({operation:'stopCurrent'});
  requireResult(stops.length || saved.persistence === 'savedDisabled' || saved.state === 'absent', 'Sharing may still be on. Try turning it off again.');
  for (const request of stops) {
    let result = await call('healthSavedRecoveryChoice', request);
    for (let attempt = 0; result.persistence === 'pending' && attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 120));
      result = await call('healthSavedRecoveryChoice', {operation:'status'});
    }
    requireResult(result.persistence === 'savedDisabled', 'This phone could not confirm sharing has stopped. Try again.');
  }
}

export async function disableAssistantSharing(call, identity) {
  let stopError;
  try { await stopHealthSharing(call); } catch (error) { stopError = error; }
  const source = await phoneSource(call);
  if (source) requireResult((await assistantSharing(call,identity,source,'disable')).enabled === false,
    'The server could not confirm that Assistant access is off.');
  if (stopError) throw stopError;
}

export function createHealthSharingView({panel, toggle, note, native, owner}) {
  let generation = 0, busy = false, statusTimer;
  function invalidate() {
    clearTimeout(statusTimer);
    generation++;
    busy = false;
    toggle.checked = false;
    toggle.disabled = true;
    note.textContent = '';
  }
  async function run(change) {
    const identity = owner();
    if (!identity || busy) return;
    clearTimeout(statusTimer);
    const token = generation;
    const current = () => token === generation && owner()?.key === identity.key;
    const call = async (name, input = {}) => {
      requireResult(current(), 'Your phone session changed.');
      const value = await native[name](input);
      requireResult(current(), 'Your phone session changed.');
      return value;
    };
    const desired = toggle.checked;
    busy = true;
    toggle.disabled = true;
    let available = true;
    function waitForStatus(message) {
      available = false;
      toggle.indeterminate = true;
      note.textContent = message;
      statusTimer = setTimeout(() => {
        if (current() && panel.open && !panel.closest('[hidden]')) void run(false);
      }, 1500);
    }
    try {
      toggle.indeterminate = false;
      const device = await call('healthSharingDevice');
      available = device.supported === true && device.configured === true;
      requireResult(device.supported, 'Apple Health is unavailable on this device.');
      requireResult(device.configured, 'This recovery build has Health disabled. Install the regular iPhone build.');
      if (change && desired) {
        await enableHealthSharing(call, identity, text => { note.textContent = text; });
        note.textContent = 'Your Assistant can use shared Health records in private chat.';
      } else if (change) {
        await disableAssistantSharing(call, identity);
        note.textContent = 'Sharing is off.';
      } else {
        const saved = await call('healthSavedRecoveryChoice', {operation:'status'});
        requireResult(Array.isArray(saved.choices), 'Health sharing status is unavailable.');
        if (saved.persistence === 'savedEnabled') toggle.checked = true;
        else if (saved.persistence === 'savedDisabled') toggle.checked = false;
        else if (saved.persistence === 'pending' || saved.state === 'pending') {
          waitForStatus('Checking whether this phone is sharing…');
          return;
        }
        else if (saved.choices.some(row => row.updatesEnabled && !row.requiresRebind)) toggle.checked = true;
        else if (saved.state === 'absent' || saved.state === 'disabled' || saved.persistence === 'requiresRebind') toggle.checked = false;
        else {
          waitForStatus('The sharing setting is unavailable. Checking again…');
          return;
        }
        const source = await phoneSource(call);
        const answers = source && (await assistantSharing(call,identity,source,'status')).enabled === true;
        if (toggle.checked && !answers) {
          toggle.checked = false;
          toggle.indeterminate = true;
          note.textContent = 'This phone is syncing. Turn on sharing to use them in private chat.';
          return;
        }
        if (answers) toggle.checked = true;
        note.textContent = toggle.checked ? 'Your Assistant can use shared Health records in private chat.' : 'Share the past 30 days and new records. Your server keeps new imports for 30 days by default.';
      }
    } catch (error) {
      if (current()) {
        if (change) { toggle.checked = !desired; toggle.indeterminate = true; }
        const info = change && desired ? await call('healthSharingDevice').catch(() => null) : null;
        if (current()) {
          if (!change && available) waitForStatus('The sharing setting is unavailable. Checking again…');
          else note.textContent = info?.problem || error.message || 'This phone could not update Health sharing.';
        }
      }
    } finally {
      if (current()) { busy = false; toggle.disabled = !available; }
    }
  }
  panel.addEventListener('toggle', () => { if (panel.open) void run(false); else clearTimeout(statusTimer); });
  toggle.addEventListener('change', () => void run(true));
  return {invalidate, refresh() { if (panel.open) void run(false); }};
}
