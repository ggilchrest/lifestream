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
- Remote or away delivery is **not configured**. The browser must be present in the active private conversation. Real enrolled sources, physical sound/privacy checks and Human acceptance remain separate requirements.

Run the condition-client, urgent storage/policy/host/HTTP and rendered-browser suites for software verification. Use a fresh synthetic condition after listening begins; a condition that predates the listener is deliberately ineligible. Keep synthetic, selected-provider, physical and Human evidence separate.
