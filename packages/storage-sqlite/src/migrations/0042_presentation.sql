CREATE TABLE presentation_selections (
  principal_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (principal_id, endpoint_id, scope_id)
);
