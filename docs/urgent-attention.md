# Urgent attention

Urgent attention consumes qualified PWCE condition metadata for an authenticated private conversation. Every source class starts disabled. Saving a rule and starting listening are separate actions. Capture and incident retention remain PWCE operations and continue independently of these notification settings.

This implementation provides a bounded software path. It does not enroll a sensor, activate a camera, install an away notification route, or establish physical audibility or Human acceptance.

## Operator configuration

Start the ordinary local candidate with the optional `--urgent-conditions PRIVATE_CONFIG_JSON` argument. Keep that file and its credential outside Git. The candidate accepts a loopback Gateway origin only. The existing `--incident-review` option remains separate.

```json
{
  "baseUrl": "http://127.0.0.1:43183",
  "token": "REPLACE_WITH_AN_EXISTING_AUTHORIZED_GATEWAY_CREDENTIAL",
  "worldRef": "world.example",
  "siteRef": "site.example",
  "replay": true,
  "bindings": [
    {
      "sourceRef": "source.synthetic",
      "eventClass": "fixture.critical",
      "worldRef": "world.example",
      "siteRef": "site.example",
      "zoneRef": "zone.example",
      "label": "Synthetic condition"
    }
  ]
}
```

This example describes synthetic test data. `replay: true` permits explicitly synthetic projections and labels their warning as a simulation. It does not turn observations into live evidence or grant producer authority. Source bindings and trusted condition ingestion must already exist in the independently configured PWCE host. No browser route can create them.

The consumer pins the generated `pwce-urgent-conditions.bundle.v1` contract and obtains current Gateway authority for the Assistant, endpoint, participants, audience, world and site. Contract, transport or authority failures stop listening. Optional `pollIntervalMs` is bounded to 250–30000 ms; transport deadlines are independently bounded.

## Conversation controls

1. Sign in as the local owner, select an Assistant, and apply a private session endpoint. Open **Conversation → Urgent attention** and choose **Refresh urgent status**.
2. Review each configured source and event class. Select **Allow this source class to interrupt** only for the classes you want. **Allow this class during quiet hours** is a separate permission; it never overrides privacy, snooze, qualification or a disabled rule.
3. Choose text or speech with transcript. Optionally set a quiet interval and its IANA time zone. Overnight intervals work; equal start and end times are rejected. Choose **Save urgent settings**.
4. Choose **Start listening for urgent conditions**. Speech uses the conversation's existing audio connection and requires a direct browser gesture. Starting listening does not open the microphone. Initial source state becomes a non-emitting baseline.
5. A newly occurring, enabled, critical, qualified and fresh condition can interrupt this destination once. Text receipt and actual software playback completion are recorded separately. A declared unsupported renderer or expressive dimension remains a degradation, even when text or speech succeeds.
6. Expand **Recent condition and delivery metadata**. **Acknowledge this alert** records a deliberate Human action only. It does not resolve the PWCE condition. Confidence and opaque evidence references can be compared with **Incident evidence**; media still requires its separate current authorization and availability checks.
7. **Snooze urgent attention** applies the selected 15-minute, one-hour or eight-hour interval. **Disable all urgent classes** also clears their quiet bypasses. **Stop listening** closes this session's delivery transport. Each action clears pending output; none replays old events when reversed.
8. The conversation's global stop button, sign-out, Assistant/session/audience changes, navigation away and hiding the page stop the local listener and clear its displayed private content. Restore a private scope and explicitly start listening again when appropriate.

## Delivery truth and failure checks

- No source configuration, opt-in, current authority, qualified private destination or ready output means no automatic warning. Inspection never enables a source or replays an alert.
- Baseline episodes, duplicate or reordered revisions, restarted consumers and cursor gaps cannot cause historical automatic output. A reconnect starts a new non-emitting baseline.
- Critical speech stops prior output through its existing lease and waits for endpoint stop settlement. It cannot claim physical acoustic silence or acquire a second audio owner.
- Source updates, resolution, expiry, policy changes and scope loss fence late text and audio. An unfinished delivery found at restart is uncertain and is not retried.
- A request to deliver, emitted text, endpoint acceptance, playback completion, Human acknowledgment and producer resolution are distinct observations. The producer acknowledgment API is only an exact-revision consumer receipt.
- Warnings use fixed Lifestream wording and the operator's binding label. Producer prose and media are not instructions or automatic memory input. Opaque evidence references remain foreign references.
- Restored databases retain historical metadata while urgent rules, bypasses and pending output are quarantined. A restore does not reauthorize delivery.
- Local conversation delivery requires the active private page. The separately configured while-away worker runs on the host without that page. Neither path enrolls a real source or selects a notification provider; actual delivery, physical sound/privacy checks and Human acceptance remain separate requirements.

Run the condition-client, urgent storage/policy/host/HTTP and rendered-browser suites for software verification. Use a fresh synthetic condition after listening begins; a condition that predates the listener is deliberately ineligible. Keep synthetic, selected-provider, physical and Human evidence separate.


## Unattended while-away destinations

`ServerOptions.urgentAway` composes a host worker with an existing authorized `CapabilityProvider` and `AuthorityDispatcher`. It also requires `urgentConditions` and local owner authentication. Each destination binds an opaque destination reference/revision, a distinct logical text endpoint, its legitimate message session and current owner authentication, the exact capability ID/version/route and scope, the qualified producer identity, and fresh authorization/privacy/suitability callbacks. The notification capability must use the exported `URGENT_AWAY_INPUT_SCHEMA` and `URGENT_AWAY_OUTPUT_SCHEMA` in `apps/server/src/runtime/urgent-away.ts`, require authority, declare an effect and support idempotency. This is a composition interface; the CLI does not load arbitrary code or accept a remote URL from the browser.

The host rechecks the real local account/session, active Assistant permission, endpoint and account epoch before each effect. A browser disconnect does not revoke the destination session. Explicit sign-out, session ending, account/permission revocation, changed destination policy, expired condition or lost recipient privacy fences queued and late effects. Local manual-solo presence cannot authorize a remote recipient. Configure recipient privacy independently for the fixed generic notice; evidence references require an additional current disclosure permission and still grant no evidence access. Provider credentials, authenticated evidence URLs and recipient addresses stay in the existing private composition, outside browser requests and the delivery journal.

Destination binding consent is durable. A new destination or changed revision, route, session, authority or producer identity begins disabled, including when that endpoint previously allowed local alerts. Local conversation controls cannot configure an endpoint reserved for unattended delivery. No constructor, source inspection or catalog lookup implies opt-in. Keep the host and approved provider running for delivery; this implementation does not wake a powered-off computer.

1. In a private owner conversation, open **While-away alerts** and choose **Refresh while-away status**. An absent route says so; there is no fabricated successful send.
2. Choose the configured **Notification destination**. Review each class's **Allow this class to notify this destination** and independent **Allow this class during quiet hours**. Optionally configure both quiet-hour times and the IANA time zone.
3. Choose **Save while-away settings**. This saves host policy; it does not send a test notification or replay historical conditions. A fresh source baseline is nonemitting. A later eligible critical episode may produce one fixed generic notice through current capability admission.
4. Close the page to exercise unattended operation. Reopen and refresh to inspect **While-away delivery history**. Distinguish reserved, locally attempted, transport accepted, denied, approval required, failed, cancelled and outcome unknown. Only schema-validated explicit provider acceptance records transport acceptance. No state means the recipient saw the notice.
5. Choose **Acknowledge while-away alert** for a transport-accepted entry only when you have reviewed it. This deliberate Human action is separate from local speech acknowledgment and from PWCE source resolution.
6. Choose a **Snooze duration** and **Snooze while-away alerts**, or choose **Disable while-away alerts**. **Disable while-away alerts** also clears quiet bypass. Changing policy cancels pending effects; reenabling begins another nonemitting baseline.

The durable journal commits a local attempted marker before provider I/O. If the process loses the reply, the outcome stays unknown and is never automatically resent. A prior uncertain authority disposition is recorded as `admission_uncertain` without inventing a local attempt. Restart cancels unattempted reservations, preserves attempted uncertainty and historical acceptance, and rebaselines the feed. A cursor gap or transport failure is fenced until the owner explicitly resaves current settings; refresh alone does not retry delivery. At most eight effects may be in flight; additional conditions are withheld with inspectable output-unavailable metadata, without delayed replay. Retention is bounded and fails closed at capacity. Notification suppression never stops the producer's independent incident recording.

Restore disables all class policies and bypasses, cancels reserved dispatches and retains attempted dispatches as uncertain. It preserves explicit Human acknowledgment history and cannot reactivate a destination. Software fixture tests make no claim that a real notification account, authorized remote evidence route or physical recipient is configured.
