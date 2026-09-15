# Isolated Initiative review

This launcher creates a fresh synthetic account, Assistant and relationship in a private temporary directory. It seeds two reviewed synthetic declarations through the protected API. It does not open an existing database or change the saved Human-review service.

Build the workspace, then start the launcher from the public repository:

```sh
pnpm build
node scripts/start-initiative-review.mjs
```

The terminal prints the local control-panel link and a private credentials-file path. The default uses **fixture providers**: it verifies the workflow, not model quality or audible voice. Open the credentials file locally and sign in with its generated username and password. Keep that file private.

1. In the control panel, open **Session disclosure**, choose the audience and click **Apply Session Disclosure**. This does not start the microphone or output.
2. In the launcher terminal, enter `sessions`. It lists numbered current browser sessions with their audience and output modes. Numbers are stable until the next `sessions` command.
3. Enter `setup 1` for the selected session number. This explicitly activates the standard synthetic Initiative settings for that session's existing endpoint. It leaves disclosure, microphone and output readiness unchanged. Use this once for initial setup; repeating it replaces the synthetic Initiative settings through a new reviewed configuration.
4. Enter `prepare 1 arrival text` (replace `1` with your session number). This creates one simulated source occurrence, valid for one minute. It does not request a reply.
5. In **Conversation → Synthetic opening test**, click **Refresh prepared cases**, select the labeled case, click **Enable case output**, then **Run this synthetic opening**. The actions and readiness status are together in that section.
6. Read the opening and its recorded outcome, then type a reply in the ordinary composer if desired. Suppression is a valid result: audience, quiet, consent, cooldown, source and unanswered-topic checks still apply.

Other preparation commands:

```text
prepare 1 check-in text
prepare 1 follow-up text
prepare 1 arrival speech
sessions
quit
```

`setup` uses the friendly synthetic reference settings: two openings per hour, eight per day and a twenty-minute minimum gap. These are ceilings, not quotas. New IDs do not bypass the gap or unanswered-topic suppression. The follow-up refers only to the seeded unfinished synthetic exercise. No actual arrival or physical presence is inferred. Creating another prepared event does not reset budgets, consent, quiet or settings. At most 128 current prepared events are retained; the picker shows up to 16. Expired events are removed, and no event survives process restart.

Speech requires the existing configured providers for meaningful voice testing. To explicitly use the already configured ai5090 services, start a **fresh** review with:

```sh
node scripts/start-initiative-review.mjs --providers ai5090
```

The existing tunnels and services must already be healthy, and the existing inference credential must already be supplied securely as `LIFESTREAM_INFERENCE_API_KEY`. Do not put the credential in a command, URL or document. The launcher does not establish tunnels, choose another model, deploy services or fall back to fixtures. Its execution profile remains `test` while the provider configuration comes from `ai5090`; both identities are recorded in the private environment marker. This path requires selected-provider verification before claiming qualification.

Use `quit` or Ctrl+C to stop only this review app. Its private directory remains for inspection; relaunching creates another fresh realm. This launcher does not implement old-database restore qualification. Browser playback completion, real-provider behavior, physical presence and Human acceptance remain separate evidence.

## Compare Initiative settings without sending an opening

In **Initiative & attention**, refresh settings and preview a saved revision (a draft is sufficient). In **Compare in the synthetic Lab**, click **Run comparison**, then **Check results** once the isolated run finishes. Results appear directly below those controls.

The table compares reserved level 2, friendly level 5, highly engaged level 11 and the selected settings. Every row sees the same twelve events over fifty virtual minutes, the same synthetic evidence/persona and the same fixture provider. Reference settings use provisional band limits and synthetic text permission. The reference counts are 0, 2 and 7; the selected row depends on its configured restrictions. Expand a row to inspect each event's time, outcome and reason. Quiet, shared audience, cooldown, opening ceilings and unanswered topics still suppress opportunities.

The selected row is a hypothetical settings projection into an isolated realm. Existing endpoint/consent permission presence maps to synthetic identifiers; it does not establish live consent or validate the real Assistant's protected bounds. Speech-only permissions do not grant text output. Settings are not activated, and no real message, audio, microphone input, model service or canonical memory is used. “Synthetic endpoint accepted” means the in-memory Lab sink accepted an opening; it is not physical delivery or Human reception. This comparison always uses its pinned fixture even when the review launcher uses ai5090. Selected-model and voiced-expression qualification remain separate.

One comparison runs at a time. Completed results remain available for ten minutes under the same account, relationship boundary and selected revision; changing those inputs requires a fresh comparison. Sign-out clears the displayed results, and stopping the host ends the worker. The Lab does not promote or change settings automatically.

## Optional timing adjustment after dismissal

Timing adaptation is off by default. In a reviewed Initiative draft, enabling **Adaptation** with a maximum deferral of 1–60 seconds permits one delay after you explicitly dismiss an opening. The next fresh, otherwise eligible opportunity waits before preparation or generation; cooldown, consent, source expiry and budgets still apply. An event that would expire during the delay is discarded. Silence alone creates no timing hint.

Conversation shows the pending adjustment under **Output for this session** after dismissal or refresh. An ordinary reply, **Quiet for this session**, or **Clear temporary mode** removes it. The hint is used once, expires within the existing metadata horizon, and does not survive host restart. Outcome inspection labels its timing plan separately from the observed delivery stage. The adjustment does not change your relationship settings or infer a lasting preference.
