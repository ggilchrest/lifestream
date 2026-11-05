-- Additive durable catalog. No existing volatile dialogue is copied here.
CREATE TABLE conversation_catalog (
  conversation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  effective_user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
  event_sequence INTEGER NOT NULL DEFAULT 0,
  last_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX conversation_catalog_scope ON conversation_catalog(effective_user_id,assistant_id,archived,pinned,last_activity_at,conversation_id);
CREATE TABLE conversation_timeline (
  entry_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversation_catalog(conversation_id),
  ordinal INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  effective_user_id TEXT NOT NULL,
  speaker TEXT NOT NULL CHECK(speaker IN ('human','assistant','system')),
  modality TEXT NOT NULL CHECK(modality IN ('text','voice')),
  state TEXT NOT NULL CHECK(state IN ('submitted','accepted','generating','interrupted','failed','completed')),
  content_state TEXT NOT NULL CHECK(content_state IN ('retained','redacted','unavailable')),
  retained_text TEXT,
  policy_ref TEXT,
  expires_at TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id,ordinal),
  CHECK((content_state='retained' AND retained_text IS NOT NULL AND policy_ref IS NOT NULL AND expires_at IS NOT NULL) OR (content_state!='retained' AND retained_text IS NULL AND policy_ref IS NULL AND expires_at IS NULL))
);
CREATE INDEX conversation_timeline_page ON conversation_timeline(conversation_id,ordinal);
CREATE TABLE conversation_operations (
  effective_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(effective_user_id,operation_id),
  UNIQUE(effective_user_id,idempotency_key)
);
CREATE TABLE conversation_catalog_clock (
  effective_user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(effective_user_id,assistant_id)
);
CREATE TABLE conversation_cursor_key (singleton INTEGER PRIMARY KEY CHECK(singleton=1),secret TEXT NOT NULL);
