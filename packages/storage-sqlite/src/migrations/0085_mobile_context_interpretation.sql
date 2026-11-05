-- Source-only A22 metadata in the existing control operation owner. UNREGISTERED.
-- No health payload, numeric result archive, grants, or new interpretation store.
ALTER TABLE mobile_context_control_operations ADD COLUMN interpretation_json TEXT
 CHECK(interpretation_json IS NULL OR
       (length(CAST(interpretation_json AS BLOB))<=32768 AND json_valid(interpretation_json) AND
        COALESCE(json_extract(interpretation_json,'$.schemaVersion')='1.0.0',0)));
CREATE TRIGGER mobile_context_interpretation_immutable
 BEFORE UPDATE OF interpretation_json ON mobile_context_control_operations
 WHEN NEW.interpretation_json IS NOT OLD.interpretation_json
 BEGIN SELECT RAISE(ABORT,'mobile_interpretation_metadata_immutable'); END;
CREATE UNIQUE INDEX mobile_context_interpretation_revision
 ON mobile_context_control_operations (
   principal_id,
   json_extract(interpretation_json,'$.scope.collector'),
   json_extract(interpretation_json,'$.scope.sourceNamespace'),
   json_extract(interpretation_json,'$.revision'))
 WHERE interpretation_json IS NOT NULL AND state='applied';
