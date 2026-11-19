-- Capacity is accounted by UTC day. Reservations are intentionally retained
-- through the day even when a session ends early: this fail-closed accounting
-- never assumes that a partially played floor performed zero D1 writes.
CREATE TABLE daily_capacity (
  day_utc TEXT PRIMARY KEY,
  requests_reserved INTEGER NOT NULL DEFAULT 0 CHECK(requests_reserved >= 0),
  reads_reserved INTEGER NOT NULL DEFAULT 0 CHECK(reads_reserved >= 0),
  writes_reserved INTEGER NOT NULL DEFAULT 0 CHECK(writes_reserved >= 0),
  ranked_writes_reserved INTEGER NOT NULL DEFAULT 0 CHECK(ranked_writes_reserved >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_capacity_reservations (
  -- This is intentionally not a foreign key: admission reserves capacity
  -- before the session row is inserted, and a failed insert remains a
  -- conservative, fail-closed reservation for the rest of the UTC day.
  floor_session_id TEXT PRIMARY KEY,
  day_utc TEXT NOT NULL REFERENCES daily_capacity(day_utc),
  mode TEXT NOT NULL CHECK(mode IN ('ranked', 'practice')),
  requests_reserved INTEGER NOT NULL CHECK(requests_reserved > 0),
  reads_reserved INTEGER NOT NULL CHECK(reads_reserved > 0),
  writes_reserved INTEGER NOT NULL CHECK(writes_reserved > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX daily_capacity_reservations_day
  ON daily_capacity_reservations(day_utc, mode);
