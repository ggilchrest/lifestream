const categories = ['SleepSegment', 'heartRate', 'restingHeartRate', 'respiratoryRate', 'hrvSDNN'];
const day = 86400000;
function requireResult(condition, message) {
  if (!condition) throw Error(message);
}

// Switch intent covers collection and transmission to this account. Existing
// Assistant access, memory, proactive use and other phones are separate.
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

export async function enableHealthSharing(call, context, notify) {
  notify('Choose what to share in Apple Health.');
  const access = await call('healthChooseRecords');
  requireResult(access.completed === true, 'Apple Health could not finish the permission request.');
  notify('Connecting this phone to Lifestream…');
  let choices = await call('healthSetupChoices');
  if (!choices.choices?.length) {
    const source = await prepareSource(call);
    const selected = source.categories.filter(c => categories.includes(c));
    requireResult(selected.length, 'This Health source has no supported record types.');
    for (const category of selected) {
      for (const purpose of ['collection', 'transmission']) await consent(call, source, category, purpose);
      const storage = await call('healthPreparePhoneStorage', {enrollmentId:source.currentEnrollmentId, category});
      requireResult(storage.ready === true, 'The server could not prepare storage for these records.');
    }
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
  requireResult(active.length || saved.persistence === 'savedDisabled' || saved.state === 'absent', 'Sharing may still be on. Try turning it off again.');
  for (const {choice} of active) {
    let result = await call('healthSavedRecoveryChoice', {operation:'stop', choice});
    for (let attempt = 0; result.persistence === 'pending' && attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 120));
      result = await call('healthSavedRecoveryChoice', {operation:'status'});
    }
    requireResult(result.persistence === 'savedDisabled', 'This phone could not confirm sharing has stopped. Try again.');
  }
}

export function createHealthSharingView({panel, toggle, note, native, owner}) {
  let generation = 0, busy = false;
  function invalidate() {
    generation++;
    busy = false;
    toggle.checked = false;
    toggle.disabled = true;
    note.textContent = '';
  }
  async function run(change) {
    const identity = owner();
    if (!identity || busy) return;
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
    try {
      const device = await call('healthSharingDevice');
      available = device.supported === true && device.configured === true;
      requireResult(device.supported, 'Apple Health is unavailable on this device.');
      requireResult(device.configured, 'This recovery build has Health disabled. Install the regular iPhone build.');
      if (change && desired) {
        await enableHealthSharing(call, identity, text => { note.textContent = text; });
        note.textContent = 'Sharing is on. You can change record access in Apple Health.';
      } else if (change) {
        await stopHealthSharing(call);
        note.textContent = 'Sharing is off.';
      } else {
        const saved = await call('healthSavedRecoveryChoice', {operation:'status'});
        requireResult(Array.isArray(saved.choices), 'Health sharing status is unavailable.');
        toggle.checked = saved.choices.some(row => row.updatesEnabled && !row.requiresRebind);
        note.textContent = toggle.checked ? 'Sharing is on.' : 'Share the past 30 days and new records. Your server keeps new imports for 30 days by default.';
      }
    } catch (error) {
      if (current()) {
        if (change) toggle.checked = !desired;
        const info = change && desired ? await call('healthSharingDevice').catch(() => null) : null;
        if (current()) note.textContent = info?.problem || error.message || 'This phone could not update Health sharing.';
      }
    } finally {
      if (current()) { busy = false; toggle.disabled = !available; }
    }
  }
  panel.addEventListener('toggle', () => { if (panel.open) void run(false); });
  toggle.addEventListener('change', () => void run(true));
  return {invalidate, refresh() { if (panel.open) void run(false); }};
}
