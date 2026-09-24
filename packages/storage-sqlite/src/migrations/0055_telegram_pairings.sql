CREATE TABLE telegram_pairings (
  subscription_id TEXT PRIMARY KEY REFERENCES channel_subscriptions(id),
  subscription_revision INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('challenge','claimed','paired','revoked')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  challenge_digest TEXT UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  chat_id TEXT,
  user_id TEXT,
  claim_id TEXT,
  conversations_enabled INTEGER NOT NULL DEFAULT 0 CHECK(conversations_enabled IN (0,1)),
  alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(alerts_enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX telegram_paired_chat ON telegram_pairings(bot_id, chat_id) WHERE state='paired';
CREATE TRIGGER telegram_subscription_changed AFTER UPDATE ON channel_subscriptions BEGIN
  UPDATE telegram_pairings SET state='revoked',revision=revision+1,challenge_digest=NULL,chat_id=NULL,user_id=NULL,claim_id=NULL,conversations_enabled=0,alerts_enabled=0 WHERE subscription_id=NEW.id;
END;
CREATE TRIGGER telegram_account_revoked AFTER UPDATE OF disabled,epoch ON local_accounts WHEN NEW.disabled!=OLD.disabled OR NEW.epoch!=OLD.epoch BEGIN
  UPDATE telegram_pairings SET state='revoked',revision=revision+1,challenge_digest=NULL,chat_id=NULL,user_id=NULL,claim_id=NULL,conversations_enabled=0,alerts_enabled=0 WHERE subscription_id IN (SELECT id FROM channel_subscriptions WHERE principal_id=NEW.principal_id);
END;
