# Subscribers and chat destinations

In a private owner conversation, open **Subscribers & chat destinations** and select **Refresh subscribers**. Choose a registered person, channel and destination name. Create additional people through **Account** first. A person may have multiple destinations, and each person has independent settings.

Choose whether the destination should support **two-way Assistant conversations**, **while-away alerts**, or both, then select **Save destination**. These are requested permissions. Saving does not pair a chat identity, connect a service, grant account administration, disclose evidence or send a message. New Telegram destinations say **Not connected · pairing required**. iOS/Android notification destinations say **Deferred · mobile endpoint required**; they do not support the conversation checkbox.

**Edit destination** changes the name and requested permissions. Subscriber and channel are immutable; create a new destination to change them. **Cancel edit** discards unsaved edits. **Disable destination** clears both requested permissions. **Remove destination** preserves a disabled historical entry, which cannot be edited or re-enabled. Stale edits are rejected: refresh before trying again. Disabled accounts cannot receive new destinations or updated permissions.

The owner administers these records for the selected Assistant. Subscriber settings confer no administrator access and do not merge identities, memories or relationship histories. Another account, another Assistant or a shared/unknown audience cannot use this screen to inspect or mutate the owner's records. Private controls clear immediately on sign-out, scope changes or privacy protection.

## Current delivery boundary

This first implementation provides durable configuration, including restart persistence and protected administration. Telegram pairing, two-way transport and its governed alert integration are the next implementation stage. No Telegram credentials or recipient addresses belong in this screen. The existing **While-away alerts** controls continue to govern only independently configured, authorized live routes; these saved entries do not automatically populate or enable them. Quiet hours, class opt-in, unknown delivery handling and Human acknowledgment remain separate.

Tests cover real isolated HTTP/SQLite account, origin, CSRF, Assistant and audience isolation; multiple subscribers/destinations; revision conflicts; persistence; disabled/removed history; and all rendered controls at desktop/mobile widths. Fixtures do not establish real Telegram delivery or Human acceptance.

## Pair your own Telegram chat

Open **Account → My chat connections → Refresh my connections** while signed in as the assigned subscriber. Owner status does not permit pairing someone else's destination. Supply the bot's numeric ID (never its token) and choose **Create pairing code**. **Replace pairing code** invalidates the previous code and any existing binding. Codes expire after ten minutes and are stored only as hashes.

A configured Telegram transport must receive `/start CODE` from your private, non-bot chat. Refresh the account screen, verify the displayed user/chat identifiers, then choose **Confirm my Telegram chat**. The confirmation is separate proof of control of your signed-in local account. **Revoke pairing** removes the usable chat binding. Changing the owner's destination settings or the subscriber's account security epoch invalidates pairing. One private chat has one active destination per bot, so no Assistant is selected ambiguously.

The pairing screen is available without Assistant administration. It reveals only the signed-in person's assignments, and clears on account change, navigation or hiding the page. It stores no bot credential. Pairing leaves both features disabled. Transport composition, feature enablement and governed alert dispatch remain implementation work; entering a code in this build does not contact Telegram. The outbound adapter is tested with synthetic responses, including ambiguous delivery without automatic resend. No live Telegram verification or Human acceptance is claimed.
