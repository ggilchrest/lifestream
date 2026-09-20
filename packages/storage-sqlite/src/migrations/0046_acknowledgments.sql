CREATE TABLE acknowledgment_catalogs (
  assistant_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  catalog_json TEXT NOT NULL
);
