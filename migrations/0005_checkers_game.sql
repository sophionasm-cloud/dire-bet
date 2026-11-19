PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS games_checkers_backup;
CREATE TABLE games_checkers_backup AS
  SELECT id, display_name, enabled, max_players, updated_at FROM games;

DROP TRIGGER IF EXISTS ethiopian_41_cannot_enable_insert;
DROP TRIGGER IF EXISTS ethiopian_41_cannot_enable_update;
DROP TRIGGER IF EXISTS ethiopian_41_cannot_delete;
DROP TRIGGER IF EXISTS ethiopian_41_id_is_fixed;

DROP TABLE games;

CREATE TABLE games (
  id TEXT PRIMARY KEY CHECK (id IN ('xo','ludo','checkers','poker','dominoes','ethiopian-41')),
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  max_players INTEGER NOT NULL DEFAULT 2 CHECK (max_players BETWEEN 2 AND 9),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO games (id, display_name, enabled, max_players, updated_at)
  SELECT id, display_name, enabled, max_players, updated_at FROM games_checkers_backup;

DROP TABLE games_checkers_backup;

CREATE TRIGGER ethiopian_41_cannot_enable_insert BEFORE INSERT ON games
WHEN NEW.id = 'ethiopian-41' AND NEW.enabled != 0
BEGIN SELECT RAISE(ABORT, 'Ethiopian 41 is permanently unavailable'); END;

CREATE TRIGGER ethiopian_41_cannot_enable_update BEFORE UPDATE OF enabled ON games
WHEN OLD.id = 'ethiopian-41' AND NEW.enabled != 0
BEGIN SELECT RAISE(ABORT, 'Ethiopian 41 is permanently unavailable'); END;

CREATE TRIGGER ethiopian_41_cannot_delete BEFORE DELETE ON games
WHEN OLD.id = 'ethiopian-41'
BEGIN SELECT RAISE(ABORT, 'Ethiopian 41 is permanently unavailable'); END;

CREATE TRIGGER ethiopian_41_id_is_fixed BEFORE UPDATE OF id ON games
WHEN OLD.id = 'ethiopian-41' OR NEW.id = 'ethiopian-41'
BEGIN SELECT RAISE(ABORT, 'Ethiopian 41 is permanently unavailable'); END;

INSERT INTO games (id, display_name, enabled, max_players)
VALUES ('checkers', 'Checkers', 1, 2)
ON CONFLICT(id) DO UPDATE SET display_name = 'Checkers', enabled = 1, max_players = 2, updated_at = CURRENT_TIMESTAMP;

UPDATE games SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 'dominoes';

INSERT INTO game_settings (game_id, rules_json, rules_confirmed)
VALUES ('checkers', '{}', 1)
ON CONFLICT(game_id) DO NOTHING;
