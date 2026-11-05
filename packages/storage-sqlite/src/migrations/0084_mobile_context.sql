CREATE TABLE mobile_context_sources (
 source_namespace TEXT PRIMARY KEY,principal_id TEXT NOT NULL,collector TEXT NOT NULL,
 revision INTEGER NOT NULL,configuration_json TEXT NOT NULL
);
-- Source-only mobile context increment. Enrollment grants no default collection/use.
CREATE TABLE mobile_context_enrollments (
 enrollment_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
 source_namespace TEXT, collector TEXT NOT NULL CHECK(collector IN ('healthKit','healthConnect')),
 revision INTEGER NOT NULL CHECK(revision>=1), state TEXT NOT NULL CHECK(state IN ('unbound','active','disconnected')),
 configuration_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(principal_id,endpoint_id,collector)
);
CREATE INDEX mobile_context_owner ON mobile_context_enrollments(principal_id,endpoint_id);
CREATE TABLE mobile_context_records (
 source_key TEXT PRIMARY KEY, suppression_key TEXT NOT NULL, principal_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
 record_type TEXT NOT NULL, source_json TEXT NOT NULL, record_json TEXT NOT NULL,
 collected_at TEXT NOT NULL, event_id TEXT NOT NULL, expires_at TEXT, policy_ref TEXT NOT NULL,
 FOREIGN KEY(enrollment_id) REFERENCES mobile_context_enrollments(enrollment_id)
);
CREATE INDEX mobile_context_record_owner ON mobile_context_records(principal_id,enrollment_id,source_key);
CREATE TABLE mobile_context_deliveries (
 principal_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')), code TEXT NOT NULL,
 received_at TEXT NOT NULL,requested_policy_revision INTEGER NOT NULL,applied_policy_revision INTEGER NOT NULL,PRIMARY KEY(principal_id,event_id)
);
-- Source-only durable operation metadata. No health payload or policy authority.
CREATE TABLE mobile_context_control_operations (
 principal_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 request_digest TEXT NOT NULL, request_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','applied','rejected')),
 outcome_json TEXT, created_at TEXT NOT NULL, decided_at TEXT,
 attempt_started INTEGER NOT NULL DEFAULT 0 CHECK(attempt_started IN (0,1)), selection_json TEXT,
 PRIMARY KEY(principal_id,operation_id),
 CHECK(state!='rejected' OR attempt_started=0),
 CHECK(state!='applied' OR attempt_started=1),
 CHECK(attempt_started=1 OR selection_json IS NULL),
 CHECK((state='pending' AND outcome_json IS NULL AND decided_at IS NULL) OR
       (state IN ('applied','rejected') AND outcome_json IS NOT NULL AND decided_at IS NOT NULL))
);
