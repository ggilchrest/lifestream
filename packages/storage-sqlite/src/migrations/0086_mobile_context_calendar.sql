-- Source-only, intentionally unregistered. Extend the SAME mobile source owner.
-- Rebuild child before parent with foreign_keys ON inside the owning transaction;
-- merely deferring constraints during a parent-only DROP can fail at COMMIT.
CREATE TABLE mobile_calendar_enrollment_copy AS
 SELECT rowid AS original_rowid,* FROM mobile_context_enrollments;
CREATE TABLE mobile_calendar_record_copy AS
 SELECT rowid AS original_rowid,* FROM mobile_context_records;
DROP TABLE mobile_context_records;
DROP TABLE mobile_context_enrollments;
CREATE TABLE mobile_context_enrollments (
 enrollment_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
 source_namespace TEXT, collector TEXT NOT NULL CHECK(collector IN ('healthKit','healthConnect','eventKit','androidCalendar','googleTasks')),
 revision INTEGER NOT NULL CHECK(revision>=1), state TEXT NOT NULL CHECK(state IN ('unbound','active','disconnected')),
 configuration_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(principal_id,endpoint_id,collector)
);
INSERT INTO mobile_context_enrollments(rowid,enrollment_id,principal_id,endpoint_id,source_namespace,collector,revision,state,configuration_json,updated_at)
 SELECT original_rowid,enrollment_id,principal_id,endpoint_id,source_namespace,collector,revision,state,configuration_json,updated_at FROM mobile_calendar_enrollment_copy;
CREATE INDEX mobile_context_owner ON mobile_context_enrollments(principal_id,endpoint_id);
CREATE TABLE mobile_context_records (
 source_key TEXT PRIMARY KEY, suppression_key TEXT NOT NULL, principal_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
 record_type TEXT NOT NULL, source_json TEXT NOT NULL, record_json TEXT NOT NULL,
 collected_at TEXT NOT NULL, event_id TEXT NOT NULL, expires_at TEXT, policy_ref TEXT NOT NULL,
 FOREIGN KEY(enrollment_id) REFERENCES mobile_context_enrollments(enrollment_id)
);
INSERT INTO mobile_context_records(rowid,source_key,suppression_key,principal_id,enrollment_id,record_type,source_json,record_json,collected_at,event_id,expires_at,policy_ref)
 SELECT original_rowid,source_key,suppression_key,principal_id,enrollment_id,record_type,source_json,record_json,collected_at,event_id,expires_at,policy_ref FROM mobile_calendar_record_copy;
CREATE INDEX mobile_context_record_owner ON mobile_context_records(principal_id,enrollment_id,source_key);
DROP TABLE mobile_calendar_record_copy;
DROP TABLE mobile_calendar_enrollment_copy;
