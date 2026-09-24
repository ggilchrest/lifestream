-- This selects a separately issued canonical grant. It is not a grant or a
-- bearer credential. Authentication stays owned by local_accounts/sessions.
CREATE TABLE telegram_notice_authority (
 subscription_id TEXT PRIMARY KEY REFERENCES channel_subscriptions(id),
 binding_digest TEXT NOT NULL,
 grant_id TEXT NOT NULL UNIQUE REFERENCES canonical_grants(grant_id),
 token_hash TEXT NOT NULL,
 session_id TEXT NOT NULL,
 session_revision INTEGER NOT NULL CHECK(session_revision > 0)
);
-- Any consent or pairing change requires another owner review.
CREATE TRIGGER telegram_notice_authority_pairing_change AFTER UPDATE ON telegram_pairings
BEGIN DELETE FROM telegram_notice_authority WHERE subscription_id=NEW.subscription_id; END;
