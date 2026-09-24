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

After authorized connection, the owner assigns a destination to an existing account. That subscriber signs into Account → My chat connections, creates a code, sends it in their own private bot chat, refreshes, checks the claimed identity, and confirms. Pairing starts neither conversations nor alerts. The subscriber enables conversations separately. `/stop`, disabling conversations, revocation and account-security changes fence affected responses. Remote physical audience starts unknown. `/private` explicitly selects personal disclosure for this session and declares that only you can see the chat for five minutes. This is a manual declaration, never sensor verification. `/shared` immediately withholds personal context; `/privacy` reports the declaration. Expiry and server restart return the audience to unknown. Unknown/shared requests receive no stored private context. Earlier dialogue is invalidated when its audience or authorization boundary changes; bounded dialogue can continue within an unchanged boundary. Audience, permission, endpoint and context changes cancel affected generation and pending output; an already attempted external send cannot be recalled.

Personal context requires an independently administered relationship belonging to the paired subscriber. Pairing alone grants no relationship, administration permission or access to another person’s memory. Attributable typed statements in an eligible private chat use the existing opt-in automatic-memory policy, including exclusions, correction and forgetting. Other subscribers can converse without personal memory; a dedicated non-administrator memory configuration flow remains pending. Existing independently authorized experiential-learning policy also applies in a private eligible chat: current retained continuations can influence an invited reply, and only current accepted delivery records completed experience and observed output. Freeze, policy/source changes and audience withdrawal retain their normal fences. The first personal-disclosure selection changes the session revision and invalidates any earlier notification grant; approve a fresh alert permission after that selection. Subsequent audience declarations do not alter an unchanged endpoint selection.

## Alerts

When both `--telegram` and `--urgent-conditions` are supplied, the generic launcher composes the configured PWCE condition source with Lifestream's canonical local Human grants. Merely configuring the host issues no grant and sends nothing. PWCE still owns condition truth; this local grant applies only to the Telegram notice capability, not to PWCE actions.

The subscriber first enables alerts independently in Account. In Conversation → Subscribers & chat destinations, the owner selects **Review alert permission**, chooses a duration (1, 7 or 30 days), then **Prepare alert permission**. Review the exact recipient, fixed-content restriction and deadline, then separately choose **Approve alert permission** or **Cancel permission review**. The request expires after five minutes. The interface uses the expiry as the review deadline; the host API also supports an earlier explicit review time. The maximum term is 30 days. Approval is a persistent, destination-specific canonical grant with no incident or memory data scope. It does not enable incident classes.

After approval, refresh Conversation → While-away alerts and choose destination-specific condition classes and quiet hours. Quiet-hour bypass remains separate for each class. Both the owner grant and subscriber consent are checked again at dispatch. Notices contain fixed generic text, with no incident details or evidence references. Only the recipient can acknowledge their own accepted alert; provider acceptance never means that a person read it. Unknown outcomes and restart do not authorize resending old conditions.

Use **Revoke alert permission** to stop future use of the selected grant. Logout from the owner's approving local session, account-security revocation, loss of administration permission, pairing/consent changes, expiry or review deadline also prevent delivery. Closing the browser or reaching the administrator idle deadline does not itself revoke an explicitly approved background grant. Background work never refreshes administrator idle time or creates a login session. The host retains only an internal reference to the already authenticated session; live checks still consult current authentication and its separate revocation safety state. Server restart can reuse an unchanged grant and binding, while a new source baseline prevents old-condition replay. Changed destination/session bindings require fresh owner review.

Trusted embedded hosts may still compose another legitimate destination-scoped authority dispatcher. Do not substitute an always-admit callback, fixture authority, or a receipt in a configuration file for live authority. The generic configuration file accepts no authority override.

## Evidence and limits

The automated launcher test uses isolated synthetic accounts and a network guard. It exercises real startup, local sign-in, disabled readiness and restart without external calls. Other channel tests cover real local authentication, pairing, canonical conversation, source qualification, policy, authority checks, durable delivery and subscriber controls using simulated Telegram. These checks do not establish live Telegram delivery, physical audience correctness or Human acceptance.

Restoring a candidate disables saved destination permissions, revokes pairings and pending codes, invalidates poll-worker ownership, cancels sends that had not started, and marks attempted sends with unknown outcomes. Accepted delivery history and poll offsets are preserved. Saved notification grant selections are cleared as well. Fresh owner intent, subscriber pairing, feature consent and an explicit notification grant are required after restore; historical acceptance never authorizes a resend. The source candidate is unaffected by isolated restore.
