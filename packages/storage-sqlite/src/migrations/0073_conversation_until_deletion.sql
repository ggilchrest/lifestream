-- Additive until-deletion representation; preserve every prior body and metadata.
ALTER TABLE conversation_timeline RENAME TO conversation_timeline_retention_legacy;
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
  retention_mode TEXT CHECK(retention_mode IN ('untilDeletion','untilExpiry')),
  UNIQUE(conversation_id,ordinal),
  CHECK((content_state='retained' AND retained_text IS NOT NULL AND policy_ref IS NOT NULL AND ((retention_mode='untilDeletion' AND expires_at IS NULL) OR (retention_mode='untilExpiry' AND expires_at IS NOT NULL))) OR (content_state!='retained' AND retained_text IS NULL AND policy_ref IS NULL AND expires_at IS NULL AND retention_mode IS NULL))
);
INSERT INTO conversation_timeline SELECT *,CASE WHEN content_state='retained' THEN 'untilExpiry' ELSE NULL END FROM conversation_timeline_retention_legacy;
DROP TABLE conversation_timeline_retention_legacy;
CREATE INDEX conversation_timeline_page ON conversation_timeline(conversation_id,ordinal);
CREATE UNIQUE INDEX conversation_timeline_identity ON conversation_timeline(conversation_id,turn_id,speaker);
