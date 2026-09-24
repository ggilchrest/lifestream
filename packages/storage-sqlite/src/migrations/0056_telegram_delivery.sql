CREATE TABLE telegram_poll_state (
  bot_id TEXT PRIMARY KEY,
  next_offset INTEGER NOT NULL CHECK(next_offset>=0),
  generation TEXT NOT NULL
);
CREATE TABLE telegram_deliveries (
  bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  subscription_id TEXT REFERENCES channel_subscriptions(id),
  state TEXT NOT NULL CHECK(state IN ('reserved','sending','accepted','rejected','unknown','cancelled','ignored','claimed')),
  receipt_id INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, update_id)
);
CREATE TABLE telegram_conversation_sessions (
  subscription_id TEXT PRIMARY KEY REFERENCES channel_subscriptions(id),
  binding_revision INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id)
);
