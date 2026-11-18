-- Account and mode are deliberately copied onto a floor session.  SQLite
-- partial unique indexes cannot enforce a constraint through the runs join.
ALTER TABLE floor_sessions ADD COLUMN account_id TEXT REFERENCES accounts(id);
ALTER TABLE floor_sessions ADD COLUMN mode TEXT CHECK(mode IN ('ranked','practice'));
ALTER TABLE floor_sessions ADD COLUMN last_action_at TEXT;

UPDATE floor_sessions
SET account_id = (SELECT account_id FROM runs WHERE runs.id = floor_sessions.run_id),
    mode = (SELECT mode FROM runs WHERE runs.id = floor_sessions.run_id),
    last_action_at = created_at
WHERE account_id IS NULL OR mode IS NULL OR last_action_at IS NULL;

CREATE UNIQUE INDEX characters_one_living_ranked_per_account
  ON characters(account_id) WHERE status = 'living';
CREATE UNIQUE INDEX floor_sessions_one_open_ranked_per_account
  ON floor_sessions(account_id) WHERE mode = 'ranked' AND status IN ('active','paused');
CREATE UNIQUE INDEX floor_sessions_one_open_practice_per_account
  ON floor_sessions(account_id) WHERE mode = 'practice' AND status IN ('active','paused');
CREATE INDEX floor_sessions_expiry_and_activity
  ON floor_sessions(status, expires_at, last_action_at);
