-- Bounded active-owner lookup must not scan retained unrelated or inactive memory corpora.
CREATE INDEX memories_context_owner_active ON memories(assistant_id,json_extract(provenance_json,'$.actor'),json_extract(lifecycle_json,'$.status'),id);
CREATE INDEX memory_correction_context ON memory_lifecycle_events(assistant_id,event_type,json_extract(payload_json,'$.correctionId'));
