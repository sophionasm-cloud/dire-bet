CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  replaced_by TEXT,
  user_agent TEXT
);
CREATE INDEX auth_sessions_user_expiry ON auth_sessions(user_id, expires_at);
CREATE INDEX auth_sessions_family ON auth_sessions(family_id);
