# Telegram host configuration

Telegram supports private, individual two-way chat. A host connection is separate from the owner's destination permissions, the subscriber's verified pairing, and each enabled feature. Group chats are unsupported. iOS and Android push endpoints remain deferred.

The candidate launcher accepts `--telegram /absolute/operator-local/telegram.json`. The file must be outside Git roots, owned by the current operating-system user, a regular file without a symlink, no larger than 8 KiB, and private (`chmod 600`). Its exact fields are:

```json
{
  "schemaVersion": "1.0.0",
  "botId": "123456789",
  "enabled": false,
  "tokenRef": {
    "kind": "env",
    "name": "LIFESTREAM_TELEGRAM_TOKEN"
  }
}
```

The numeric bot ID above is illustrative. Replace it with the intended bot ID. Store the bot token in the referenced process environment through your existing local secret mechanism. The configuration file never contains the token. Inline credentials, arbitrary network origins, injected transports, subscriber records and authority receipts are rejected. Environment reference names must start with `LIFESTREAM_`.

With `enabled: false`, startup requires no token and makes no Telegram calls. The Account page can show the configured bot ID and retain local pairing setup. Existing provider selection, private assets and audience protections remain independent.

Setting `enabled: true` and restarting is a separate live connection action: it permits outbound requests to Telegram's fixed Bot API, beginning with bot identity verification and private-message polling. Startup requires a token matching the configured bot ID. This guide does not authorize that action. No inbound listener, webhook or external exposure is required. Stop the host or return `enabled` to false and restart to stop polling; never launch two hosts over the same live database.

After authorized connection, the owner assigns a destination to an existing account. That subscriber signs into Account → My chat connections, creates a code, sends it in their own private bot chat, refreshes, checks the claimed identity, and confirms. Pairing starts neither conversations nor alerts. The subscriber enables conversations separately. `/stop`, disabling conversations, revocation and account-security changes fence affected responses. Conversation context remains bounded and remote physical audience is unknown; private stored persona and memory are currently withheld.

## Alerts

The generic candidate file configures the chat transport only. It does not mint notification authority. The existing host composition API additionally accepts configured condition sources and a current, destination-scoped authority dispatcher. Until that composition is supplied, alerts remain unavailable even if the owner requests them. Do not substitute an always-admit callback, fixture authority, or a receipt in a configuration file for live authority.

When a legitimate alert composition is present, the subscriber enables alerts independently in Account. The owner then chooses destination-specific condition classes and quiet hours in Conversation → While-away alerts. Quiet-hour bypass is a separate choice for each class. Changed pairing/session bindings require owner policy review. Notices contain fixed generic text, with no incident details or evidence references. Only the recipient can acknowledge their own accepted alert; provider acceptance never means that a person read it. Unknown outcomes and restart do not authorize resending old conditions.

## Evidence and limits

The automated launcher test uses isolated synthetic accounts and a network guard. It exercises real startup, local sign-in, disabled readiness and restart without external calls. Other channel tests cover real local authentication, pairing, canonical conversation, source qualification, policy, authority checks, durable delivery and subscriber controls using simulated Telegram. These checks do not establish live Telegram delivery, physical audience correctness or Human acceptance.

Restoring a candidate disables saved destination permissions, revokes pairings and pending codes, invalidates poll-worker ownership, cancels sends that had not started, and marks attempted sends with unknown outcomes. Accepted delivery history and poll offsets are preserved. Fresh owner intent, subscriber pairing and feature consent are required after restore; historical acceptance never authorizes a resend. The source candidate is unaffected by isolated restore.
