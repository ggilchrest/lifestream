-- Restoring suspends collection and learning without treating suspension as withdrawal.
-- This exact policy revision permits retention only; a subsequent policy edit expires it.
CREATE TABLE experience_restore_quarantine (
 scope_key TEXT PRIMARY KEY,
 memory_policy_revision INTEGER NOT NULL
);
