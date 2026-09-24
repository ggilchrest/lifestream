-- Consumer policy and output truth only; producer conditions remain foreign projections.
CREATE TABLE urgent_attention_settings (
 scope_key TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json))
);
-- Episode tombstones deliberately survive delivery completion and consumer restart.
CREATE TABLE urgent_attention_conditions (
 scope_key TEXT NOT NULL,
 condition_ref TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 updated_at TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 PRIMARY KEY(scope_key,condition_ref)
);
CREATE INDEX urgent_attention_conditions_scope ON urgent_attention_conditions(scope_key,updated_at DESC);
CREATE TABLE urgent_attention_deliveries (
 delivery_id TEXT PRIMARY KEY,
 scope_key TEXT NOT NULL,
 condition_ref TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 stage TEXT NOT NULL CHECK(stage IN ('queued','started','delivered','completed','cancelled','uncertain')),
 updated_at TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 UNIQUE(scope_key,condition_ref)
);
CREATE INDEX urgent_attention_deliveries_scope ON urgent_attention_deliveries(scope_key,updated_at DESC);
CREATE INDEX urgent_attention_deliveries_stage ON urgent_attention_deliveries(stage);
