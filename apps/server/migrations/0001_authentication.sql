-- Authentication is deliberately separate from GitHub's mutable profile data.
ALTER TABLE accounts ADD COLUMN ranked_enrolled_at TEXT;
ALTER TABLE credentials ADD COLUMN label TEXT;
ALTER TABLE credentials ADD COLUMN last_used_at TEXT;
CREATE UNIQUE INDEX accounts_display_name_unique
  ON accounts(display_name) WHERE display_name IS NOT NULL;
CREATE INDEX credentials_account_active ON credentials(account_id, revoked_at, expires_at);
