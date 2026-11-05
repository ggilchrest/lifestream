-- Source-only scoped migration. Deliberately absent from the runtime catalog.
CREATE TABLE mobile_context_policy_operations (
 principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, scope_digest TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('approveMapping','revokeMapping','setRawRetention')),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB))<=131072 AND json_valid(request_json)),
 original_endpoint_id TEXT NOT NULL, actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), received_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','applied')), attempt_started INTEGER NOT NULL CHECK(attempt_started IN (0,1)),
 prepared_json TEXT CHECK(prepared_json IS NULL OR length(CAST(prepared_json AS BLOB))<=262144 AND json_valid(prepared_json)),
 outcome_json TEXT CHECK(outcome_json IS NULL OR length(CAST(outcome_json AS BLOB))<=524288 AND json_valid(outcome_json)),
 PRIMARY KEY(principal_id,operation_id),
 CHECK((attempt_started=0 AND prepared_json IS NULL) OR (attempt_started=1 AND prepared_json IS NOT NULL)),
 CHECK((state='pending' AND outcome_json IS NULL) OR (state='applied' AND outcome_json IS NOT NULL AND attempt_started=1))
);
CREATE TRIGGER mobile_policy_original_immutable BEFORE UPDATE ON mobile_context_policy_operations
 WHEN NEW.principal_id IS NOT OLD.principal_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.scope_digest IS NOT OLD.scope_digest
 OR NEW.kind IS NOT OLD.kind OR NEW.request_digest IS NOT OLD.request_digest OR NEW.request_json IS NOT OLD.request_json
 OR NEW.original_endpoint_id IS NOT OLD.original_endpoint_id OR NEW.actor_json IS NOT OLD.actor_json OR NEW.received_at IS NOT OLD.received_at
 OR NEW.attempt_started<OLD.attempt_started OR OLD.prepared_json IS NOT NULL AND NEW.prepared_json IS NOT OLD.prepared_json
 OR OLD.outcome_json IS NOT NULL AND NEW.outcome_json IS NOT OLD.outcome_json OR OLD.state='applied' AND NEW.state IS NOT OLD.state
 BEGIN SELECT RAISE(ABORT,'mobile_policy_original_immutable'); END;
CREATE TRIGGER mobile_policy_original_no_delete BEFORE DELETE ON mobile_context_policy_operations BEGIN SELECT RAISE(ABORT,'mobile_policy_original_immutable'); END;
CREATE TABLE mobile_context_policy_decisions (
 scope_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('classification','rawRetention')), scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 previous_revision INTEGER NOT NULL CHECK(previous_revision>=0 AND previous_revision=revision-1),
 value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB))<=4096 AND json_valid(value_json)),
 value_digest TEXT NOT NULL CHECK(length(value_digest)=64), operation_principal_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), decided_at TEXT NOT NULL,
 PRIMARY KEY(scope_digest,revision),
 FOREIGN KEY(operation_principal_id,operation_id) REFERENCES mobile_context_policy_operations(principal_id,operation_id)
);
CREATE TRIGGER mobile_policy_decision_chain BEFORE INSERT ON mobile_context_policy_decisions
 WHEN NEW.previous_revision<>COALESCE((SELECT MAX(revision) FROM mobile_context_policy_decisions WHERE scope_digest=NEW.scope_digest),0)
 BEGIN SELECT RAISE(ABORT,'mobile_policy_revision_conflict'); END;
CREATE TRIGGER mobile_policy_decision_no_update BEFORE UPDATE ON mobile_context_policy_decisions BEGIN SELECT RAISE(ABORT,'mobile_policy_decision_immutable'); END;
CREATE TRIGGER mobile_policy_decision_no_delete BEFORE DELETE ON mobile_context_policy_decisions BEGIN SELECT RAISE(ABORT,'mobile_policy_decision_immutable'); END;
-- Multiple immutable captured bindings per accepted canonical identity; firstImport never changes.
CREATE TABLE mobile_context_policy_records (
 principal_id TEXT NOT NULL, source_key TEXT NOT NULL, suppression_key TEXT NOT NULL,
 first_authoritative_import_at TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB))<=32768 AND json_valid(binding_json)),
 binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64), source_scope_digest TEXT NOT NULL,
 PRIMARY KEY(principal_id,source_key,binding_digest)
);
CREATE TRIGGER mobile_policy_import_once BEFORE INSERT ON mobile_context_policy_records
 WHEN EXISTS(SELECT 1 FROM mobile_context_policy_records WHERE principal_id=NEW.principal_id AND source_key=NEW.source_key
 AND (first_authoritative_import_at<>NEW.first_authoritative_import_at OR suppression_key<>NEW.suppression_key OR source_scope_digest<>NEW.source_scope_digest))
 BEGIN SELECT RAISE(ABORT,'mobile_policy_import_identity_changed'); END;
CREATE TRIGGER mobile_policy_record_no_update BEFORE UPDATE ON mobile_context_policy_records BEGIN SELECT RAISE(ABORT,'mobile_policy_record_immutable'); END;
CREATE TRIGGER mobile_policy_record_no_delete BEFORE DELETE ON mobile_context_policy_records BEGIN SELECT RAISE(ABORT,'mobile_policy_record_immutable'); END;
