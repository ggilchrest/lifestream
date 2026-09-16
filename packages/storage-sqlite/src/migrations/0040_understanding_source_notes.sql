ALTER TABLE understanding_projection ADD COLUMN qualification_revision INTEGER NOT NULL DEFAULT 0;
-- Only pending repair rows belong in this index; indexing qualified rows can
-- make SQLite scan the corpus before consulting the full-text match.
CREATE INDEX understanding_projection_qualification ON understanding_projection(projection_id) WHERE qualification_revision=0;
