CREATE TABLE IF NOT EXISTS memory_lifecycle_events (
  event_id INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (memory_id, revision)
);
INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at)
SELECT id, assistant_id, 1, 'created', lifecycle_json, created_at
FROM memories AS m
WHERE NOT EXISTS (SELECT 1 FROM memory_lifecycle_events AS e WHERE e.memory_id = m.id);
