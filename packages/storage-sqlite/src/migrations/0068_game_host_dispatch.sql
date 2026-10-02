CREATE TABLE game_host_dispatch (
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  attachment_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','entered','unresolved')),
  receipt_digest TEXT,
  PRIMARY KEY(run_id, action_id),
  FOREIGN KEY(run_id, action_id) REFERENCES activity_controller_reservations(run_id, action_id)
);
