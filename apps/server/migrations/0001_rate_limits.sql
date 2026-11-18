CREATE TABLE rate_limits (
  scope TEXT NOT NULL,
  client_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  PRIMARY KEY(scope, client_key, window_start)
);
