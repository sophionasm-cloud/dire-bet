ALTER TABLE users ADD COLUMN web_username TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX users_web_username_unique ON users(web_username COLLATE NOCASE) WHERE web_username IS NOT NULL;

CREATE TABLE user_contacts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_ciphertext TEXT NOT NULL,
  shared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
