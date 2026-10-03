ALTER TABLE automatic_memory_work ADD COLUMN proposal_digest TEXT;
ALTER TABLE automatic_memory_work ADD COLUMN source_context_json TEXT;
CREATE INDEX automatic_memory_policy_owner ON automatic_memory_policies(principal_id,assistant_id,relationship_id);
