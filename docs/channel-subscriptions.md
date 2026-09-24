# Subscribers and chat destinations

In a private owner conversation, open **Subscribers & chat destinations** and select **Refresh subscribers**. Choose a registered person, channel and destination name. Create additional people through **Account** first. A person may have multiple destinations, and each person has independent settings.

Choose whether the destination should support **two-way Assistant conversations**, **while-away alerts**, or both, then select **Save destination**. These are requested permissions. Saving does not pair a chat identity, connect a service, grant account administration, disclose evidence or send a message. New Telegram destinations say **Not connected · pairing required**. iOS/Android notification destinations say **Deferred · mobile endpoint required**; they do not support the conversation checkbox.

**Edit destination** changes the name and requested permissions. Subscriber and channel are immutable; create a new destination to change them. **Cancel edit** discards unsaved edits. **Disable destination** clears both requested permissions. **Remove destination** preserves a disabled historical entry, which cannot be edited or re-enabled. Stale edits are rejected: refresh before trying again. Disabled accounts cannot receive new destinations or updated permissions.

The owner administers these records for the selected Assistant. Subscriber settings confer no administrator access and do not merge identities, memories or relationship histories. Another account, another Assistant or a shared/unknown audience cannot use this screen to inspect or mutate the owner's records. Private controls clear immediately on sign-out, scope changes or privacy protection.

## Current delivery boundary

This first implementation provides durable configuration, including restart persistence and protected administration. Telegram pairing, two-way transport and its governed alert integration are the next implementation stage. No Telegram credentials or recipient addresses belong in this screen. The existing **While-away alerts** controls continue to govern only independently configured, authorized live routes; these saved entries do not automatically populate or enable them. Quiet hours, class opt-in, unknown delivery handling and Human acknowledgment remain separate.

Tests cover real isolated HTTP/SQLite account, origin, CSRF, Assistant and audience isolation; multiple subscribers/destinations; revision conflicts; persistence; disabled/removed history; and all rendered controls at desktop/mobile widths. Fixtures do not establish real Telegram delivery or Human acceptance.
