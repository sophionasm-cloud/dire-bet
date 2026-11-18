ALTER TABLE payment_settings ADD COLUMN account_number TEXT;
ALTER TABLE game_rooms ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1));
ALTER TABLE deposit_requests ADD COLUMN sender_phone_ciphertext TEXT;

CREATE TABLE withdrawal_requests_preview (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet_kind TEXT NOT NULL DEFAULT 'demo' CHECK (wallet_kind IN ('demo','real')),
  amount_santim INTEGER NOT NULL CHECK (amount_santim > 0),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewing','approved','rejected','paid')),
  idempotency_key TEXT NOT NULL UNIQUE,
  reviewed_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  destination_phone_ciphertext TEXT,
  account_holder_ciphertext TEXT,
  review_reason TEXT,
  paid_at TEXT
);

INSERT INTO withdrawal_requests_preview (
  id, user_id, wallet_kind, amount_santim, provider, status, idempotency_key,
  reviewed_by, approved_by, created_at, reviewed_at
)
SELECT id, user_id, wallet_kind, amount_santim, provider, status, idempotency_key,
  reviewed_by, approved_by, created_at, reviewed_at
FROM withdrawal_requests;

DROP TABLE withdrawal_requests;
ALTER TABLE withdrawal_requests_preview RENAME TO withdrawal_requests;

CREATE UNIQUE INDEX agent_commissions_match_unique
  ON agent_commissions(agent_id, referred_user_id, match_id)
  WHERE match_id IS NOT NULL;

INSERT INTO payment_settings
  (provider, account_label, account_number, instructions_i18n, enabled, minimum_santim, maximum_santim)
VALUES
  ('telebirr', '', '0956870660', '{}', 1, 5000, 1000000),
  ('ebirr', '', '0956870660', '{}', 1, 5000, 1000000)
ON CONFLICT(provider) DO NOTHING;

CREATE TABLE agent_weekly_activity (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  referred_user_id INTEGER NOT NULL REFERENCES users(id),
  match_id TEXT NOT NULL REFERENCES matches(id),
  week_start TEXT NOT NULL,
  net_result_santim INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, referred_user_id, match_id)
);
CREATE INDEX agent_weekly_activity_agent_week ON agent_weekly_activity(agent_id, week_start);
