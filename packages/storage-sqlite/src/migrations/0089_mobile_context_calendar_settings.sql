-- Optional Calendar source settings only. No defaults, grants or policy records.
ALTER TABLE mobile_context_enrollments ADD COLUMN sync_window_json TEXT
 CHECK(sync_window_json IS NULL OR
       (length(CAST(sync_window_json AS BLOB))<=4096 AND json_valid(sync_window_json)));
