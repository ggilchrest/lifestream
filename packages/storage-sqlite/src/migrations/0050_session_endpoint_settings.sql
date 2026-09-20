-- Logical endpoint identity/defaults may persist across sign-ins. Disclosure and
-- negotiated modalities belong to one session, never to a shared endpoint row.
CREATE TABLE session_endpoint_settings (
  session_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('text', 'audio')),
  audience_scope TEXT NOT NULL CHECK(audience_scope IN ('unknown', 'authenticatedSession')),
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision > 0)
);
-- Do not infer legacy session consent from the last writer of a shared endpoint.
-- Missing settings resolve to unknown disclosure and text until explicitly set.
