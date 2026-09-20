CREATE TABLE saved_voice_definitions (
  voice_ref TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  UNIQUE(assistant_id, revision)
);
CREATE TABLE saved_voice_previews (
  preview_id TEXT PRIMARY KEY,
  voice_ref TEXT NOT NULL REFERENCES saved_voice_definitions(voice_ref),
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_binding TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
