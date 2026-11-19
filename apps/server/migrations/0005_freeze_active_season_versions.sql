CREATE TRIGGER seasons_freeze_active_versions
BEFORE UPDATE OF ruleset_version, generator_version, content_version ON seasons
WHEN OLD.state IN ('active', 'ended', 'revealed')
BEGIN
  SELECT RAISE(ABORT, 'active season versions are immutable');
END;
