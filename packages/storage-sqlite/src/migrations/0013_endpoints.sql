CREATE TABLE IF NOT EXISTS interaction_endpoints (
  endpoint_id TEXT PRIMARY KEY,
  configuration_revision INTEGER NOT NULL,
  endpoint_class TEXT NOT NULL,
  ownership TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  health TEXT NOT NULL
);
