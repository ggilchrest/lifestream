# Subscribers and chat destinations

In a private owner conversation, open **Subscribers & chat destinations** and select **Refresh subscribers**. Choose a registered person, channel and destination name. Create additional people through **Account** first. A person may have multiple destinations, and each person has independent settings.

Choose whether the destination should support **two-way Assistant conversations**, **while-away alerts**, or both, then select **Save destination**. These are requested permissions. Saving does not pair a chat identity, connect a service, grant account administration, disclose evidence or send a message. New Telegram destinations say **Not connected · pairing required**. iOS/Android notification destinations say **Deferred · mobile endpoint required**; they do not support the conversation checkbox.

**Edit destination** changes the name and requested permissions. Subscriber and channel are immutable; create a new destination to change them. **Cancel edit** discards unsaved edits. **Disable destination** clears both requested permissions. **Remove destination** preserves a disabled historical entry, which cannot be edited or re-enabled. Stale edits are rejected: refresh before trying again. Disabled accounts cannot receive new destinations or updated permissions.

The owner administers these records for the selected Assistant. Subscriber settings confer no administrator access and do not merge identities, memories or relationship histories. Another account, another Assistant or a shared/unknown audience cannot use this screen to inspect or mutate the owner's records. Private controls clear immediately on sign-out, scope changes or privacy protection.

## Current delivery boundary

This first implementation provides durable configuration, including restart persistence and protected administration. Subscriber-owned Telegram pairing and two-way text transport are implemented behind explicit host composition. Governed alert integration remains the next stage. No Telegram credentials or recipient addresses belong in this screen. The existing **While-away alerts** controls continue to govern only independently configured, authorized live routes; these saved entries do not automatically populate or enable them. Quiet hours, class opt-in, unknown delivery handling and Human acknowledgment remain separate.

Tests cover real isolated HTTP/SQLite account, origin, CSRF, Assistant and audience isolation; multiple subscribers/destinations; revision conflicts; persistence; disabled/removed history; and all rendered controls at desktop/mobile widths. Fixtures do not establish real Telegram delivery or Human acceptance.

## Pair your own Telegram chat

Open **Account → My chat connections → Refresh my connections** while signed in as the assigned subscriber. Owner status does not permit pairing someone else's destination. Supply the bot's numeric ID (never its token) and choose **Create pairing code**. **Replace pairing code** invalidates the previous code and any existing binding. Codes expire after ten minutes and are stored only as hashes.

A configured Telegram transport must receive `/start CODE` from your private, non-bot chat. Refresh the account screen, verify the displayed user/chat identifiers, then choose **Confirm my Telegram chat**. The confirmation is separate proof of control of your signed-in local account. **Revoke pairing** removes the usable chat binding. Changing the owner's destination settings or the subscriber's account security epoch invalidates pairing. One private chat has one active destination per bot, so no Assistant is selected ambiguously.

The pairing screen is available without Assistant administration. It reveals only the signed-in person's assignments, and clears on account change, navigation or hiding the page. It stores no bot credential. Pairing leaves both features disabled. A server composed with an explicitly enabled Telegram host can receive the private-chat claim and expose **Enable conversations** and **Disable conversations** after pairing. Entering the numeric bot ID alone does not connect anything. Governed alert dispatch remains implementation work. The outbound adapter is tested with synthetic responses, including ambiguous delivery without automatic resend. No live Telegram verification or Human acceptance is claimed.


## Configured two-way transport

The composition host may supply `ServerOptions.telegram` with a numeric bot ID, an operator-local token resolver and an explicit enablement guard. An injected transport is permitted only in the test profile. No token is accepted through the browser. The host polls outbound only; it opens no inbound Telegram listener. Quarantined restores reject the transport. Changing runtime profiles stops the channel until a fresh host composition.

After pairing with the configured bot, **Enable conversations** activates only the owner's requested conversation permission. **Disable conversations**, **Revoke pairing**, owner destination changes, account-security changes and `/stop` cancel affected work. The signed-in subscriber receives no administrator or tool permission. Each binding uses a canonical logical endpoint/session and separate bounded dialogue. Provider-accepted messages enter dialogue only after the transport accepts them; this is not a Human-read receipt. Uncertain sends are durable and never automatically resent. Restart preserves the update cursor and delivery deduplication, while volatile conversation history starts empty. The last 512 delivery metadata records are retained; raw messages are not copied into that ledger.

The selected inference provider and canonical prompt builder produce replies. Current channel audience is unknown: private stored memory/persona, media and tools are withheld. A channel disclosure/automatic-memory policy and governed alerts remain open integration work. iOS/Android endpoints remain deferred. Software tests and isolated selected-provider tests use simulated Telegram transport and do not establish live chat acceptance.

## Governed alert adapter

`TelegramNoticeProvider` implements the existing urgent-away capability contract. It requires current pairing with independently enabled alert consent, the exact destination/scope, a current authority dispatch receipt, and a fresh condition notice. It accepts only the two fixed redacted notice strings and no evidence references or arbitrary prose. The existing urgent-away worker owns condition qualification, class opt-in, quiet hours/bypass, episode deduplication and Human acknowledgment.

A durable transport journal records the attempt before I/O. Accepted, rejected and unknown outcomes remain distinct; uncertain attempts are not resent after restart. A changed invocation payload cannot reuse an existing key. The journal fails closed at 4,096 entries until an explicit maintenance policy is implemented. Provider acceptance never marks the condition acknowledged.

The adapter is joined to the real policy/resolver/journal in no-network tests. Dynamic subscriber-to-away-route composition, owner alert-policy controls and recipient alert consent are still pending; the application continues to show alerts unavailable. No live condition, Telegram destination or recording source has been activated.
