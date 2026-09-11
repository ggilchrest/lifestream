CREATE TABLE IF NOT EXISTS persona_adaptation_events (
  event_id INTEGER PRIMARY KEY,
  adaptation_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE(adaptation_id, revision)
);

INSERT INTO persona_adaptation_events (adaptation_id, assistant_id, revision, event_type, payload_json, occurred_at)
SELECT id, assistant_id, 1, 'created', evidence_json, created_at
FROM persona_adaptations AS a
WHERE NOT EXISTS (SELECT 1 FROM persona_adaptation_events AS e WHERE e.adaptation_id = a.id);
