PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','am','so','om')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','restricted','suspended','self_excluded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_url TEXT,
  display_name TEXT,
  age_eligibility TEXT NOT NULL DEFAULT 'unverified' CHECK (age_eligibility IN ('unverified','verified','blocked')),
  age_review_reference TEXT,
  self_excluded_until TEXT,
  cooling_off_until TEXT,
  responsible_play_limits TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_user_expiry ON sessions(user_id, expires_at);

CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE permissions (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER UNIQUE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled','locked')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE admin_credentials (
  admin_id TEXT PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT
);
CREATE TABLE admin_mfa_credentials (
  admin_id TEXT PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  encrypted_secret TEXT,
  passkey_credential_id TEXT,
  passkey_public_key TEXT,
  enabled_at TEXT,
  recovery_hashes TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE games (
  id TEXT PRIMARY KEY CHECK (id IN ('xo','ludo','dominoes','poker','ethiopian-41')),
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  max_players INTEGER NOT NULL DEFAULT 2 CHECK (max_players BETWEEN 2 AND 9),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO games (id, display_name, enabled, max_players) VALUES
  ('xo','XO',1,2), ('ludo','Ludo',0,4), ('dominoes','Dominoes',0,4),
  ('poker','Texas Hold’em',0,6), ('ethiopian-41','Ethiopian 41',0,4);
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
CREATE TABLE game_settings (
  game_id TEXT PRIMARY KEY REFERENCES games(id),
  rules_json TEXT NOT NULL DEFAULT '{}',
  rules_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (rules_confirmed IN (0,1)),
  turn_seconds INTEGER NOT NULL DEFAULT 30 CHECK (turn_seconds BETWEEN 10 AND 120),
  voice_enabled INTEGER NOT NULL DEFAULT 0 CHECK (voice_enabled IN (0,1)),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO game_settings (game_id, rules_json, rules_confirmed) VALUES ('xo','{}',1);

CREATE TABLE game_rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL REFERENCES games(id),
  host_user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished','cancelled')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 9),
  mode TEXT NOT NULL DEFAULT 'free' CHECK (mode IN ('free','practice')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);
CREATE INDEX game_rooms_status_created ON game_rooms(status, created_at);
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES game_rooms(id),
  game_id TEXT NOT NULL REFERENCES games(id),
  status TEXT NOT NULL CHECK (status IN ('active','completed','voided')),
  bot_match INTEGER NOT NULL DEFAULT 0 CHECK (bot_match IN (0,1)),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  result_json TEXT
);
CREATE INDEX matches_game_started ON matches(game_id, started_at DESC);
CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  seat INTEGER NOT NULL,
  bot_label TEXT,
  result TEXT CHECK (result IN ('win','loss','draw','void')),
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX match_players_user ON match_players(user_id, match_id);
CREATE TABLE match_events (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (match_id, sequence)
);
CREATE TRIGGER match_events_no_update BEFORE UPDATE ON match_events BEGIN SELECT RAISE(ABORT, 'match events are append-only'); END;
CREATE TRIGGER match_events_no_delete BEFORE DELETE ON match_events BEGIN SELECT RAISE(ABORT, 'match events are append-only'); END;
CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','rejected')),
  reason TEXT NOT NULL,
  notes TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE TABLE leaderboards (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game_id TEXT REFERENCES games(id),
  period TEXT NOT NULL CHECK (period IN ('daily','weekly','all_time')),
  score INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, game_id, period)
);
CREATE TABLE friendships (
  user_id INTEGER NOT NULL REFERENCES users(id),
  friend_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','blocked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, friend_user_id),
  CHECK (user_id != friend_user_id)
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet_kind TEXT NOT NULL CHECK (wallet_kind IN ('demo','promo','real')),
  balance_santim INTEGER NOT NULL DEFAULT 0 CHECK (balance_santim >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, wallet_kind)
);
CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  wallet_kind TEXT NOT NULL CHECK (wallet_kind IN ('demo','promo','real')),
  category TEXT NOT NULL CHECK (category IN ('deposit','promo_credit','match_entry','match_payout','platform_fee','provider_fee','agent_commission','refund','adjustment','expense')),
  amount_santim INTEGER NOT NULL CHECK (amount_santim != 0),
  balance_after_santim INTEGER NOT NULL CHECK (balance_after_santim >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','system','provider')),
  actor_id TEXT,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX wallet_transactions_wallet_time ON wallet_transactions(wallet_id, created_at DESC);
CREATE TRIGGER wallet_transactions_no_update BEFORE UPDATE ON wallet_transactions BEGIN SELECT RAISE(ABORT, 'wallet transactions are append-only'); END;
CREATE TRIGGER wallet_transactions_no_delete BEFORE DELETE ON wallet_transactions BEGIN SELECT RAISE(ABORT, 'wallet transactions are append-only'); END;
CREATE TRIGGER wallet_transaction_balance_check BEFORE INSERT ON wallet_transactions
WHEN NEW.wallet_kind != (SELECT wallet_kind FROM wallets WHERE id = NEW.wallet_id)
  OR NEW.balance_after_santim != (SELECT balance_santim + NEW.amount_santim FROM wallets WHERE id = NEW.wallet_id)
  OR NEW.balance_after_santim < 0
BEGIN SELECT RAISE(ABORT, 'wallet transaction balance mismatch'); END;
CREATE TRIGGER wallet_transaction_update_balance AFTER INSERT ON wallet_transactions
BEGIN UPDATE wallets SET balance_santim = NEW.balance_after_santim, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.wallet_id; END;
CREATE TABLE deposit_requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet_kind TEXT NOT NULL DEFAULT 'demo' CHECK (wallet_kind IN ('demo','real')),
  provider TEXT NOT NULL,
  amount_santim INTEGER NOT NULL CHECK (amount_santim BETWEEN 5000 AND 1000000),
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_info','approved','rejected')),
  idempotency_key TEXT NOT NULL UNIQUE,
  reviewed_by TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  UNIQUE (provider, provider_reference)
);
CREATE INDEX deposits_status_created ON deposit_requests(status, created_at);
CREATE TABLE receipt_blobs (
  id TEXT PRIMARY KEY,
  deposit_request_id TEXT NOT NULL UNIQUE REFERENCES deposit_requests(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','application/pdf')),
  encrypted_blob BLOB NOT NULL,
  retention_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE withdrawal_requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet_kind TEXT NOT NULL DEFAULT 'real' CHECK (wallet_kind = 'real'),
  amount_santim INTEGER NOT NULL CHECK (amount_santim > 0),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewing','approved','rejected','paid')),
  idempotency_key TEXT NOT NULL UNIQUE,
  reviewed_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE TABLE payment_settings (
  provider TEXT PRIMARY KEY CHECK (provider IN ('telebirr','ebirr')),
  account_label TEXT,
  instructions_i18n TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  minimum_santim INTEGER,
  maximum_santim INTEGER,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  referral_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','revoked')),
  commission_rule_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE agent_credentials (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  password_hash TEXT,
  mfa_secret_encrypted TEXT,
  mfa_recovery_hashes TEXT NOT NULL DEFAULT '[]',
  onboarding_token_hash TEXT UNIQUE,
  onboarding_expires_at TEXT
);
CREATE TABLE referrals (
  id TEXT PRIMARY KEY,
  referred_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  referrer_user_id INTEGER REFERENCES users(id),
  agent_id TEXT REFERENCES agents(id),
  source_code TEXT NOT NULL,
  fraud_flag TEXT,
  device_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (referrer_user_id IS NULL OR referrer_user_id != referred_user_id),
  CHECK (referrer_user_id IS NULL OR agent_id IS NULL)
);
CREATE TABLE agent_commissions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  referred_user_id INTEGER NOT NULL REFERENCES users(id),
  match_id TEXT REFERENCES matches(id),
  amount_santim INTEGER NOT NULL CHECK (amount_santim >= 0),
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','pending','eligible','paid','void')),
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE TABLE promo_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('demo_credit','promo_credit')),
  amount_santim INTEGER NOT NULL CHECK (amount_santim > 0),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_redemptions INTEGER NOT NULL CHECK (max_redemptions > 0),
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  eligible_groups_json TEXT NOT NULL DEFAULT '[]',
  new_user_only INTEGER NOT NULL DEFAULT 0 CHECK (new_user_only IN (0,1)),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  campaign_owner TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE promo_redemptions (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES promo_codes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  redemption_no INTEGER NOT NULL,
  wallet_kind TEXT NOT NULL CHECK (wallet_kind IN ('demo','promo')),
  amount_santim INTEGER NOT NULL CHECK (amount_santim > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (code_id, user_id, redemption_no)
);
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  title_i18n TEXT NOT NULL,
  body_i18n TEXT NOT NULL,
  image_path TEXT,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  title_i18n TEXT NOT NULL,
  body_i18n TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','retry','blocked','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX notification_outbox_pending ON notification_outbox(status, available_at);
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user','admin')),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE voice_reports (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES game_rooms(id),
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  reported_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin','system','provider')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_logs_action_created ON audit_logs(action, created_at DESC);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TABLE application_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE activation_records (
  id TEXT PRIMARY KEY,
  evidence_json TEXT NOT NULL,
  minimum_age INTEGER NOT NULL CHECK (minimum_age BETWEEN 1 AND 120),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER activation_records_no_update BEFORE UPDATE ON activation_records BEGIN SELECT RAISE(ABORT, 'activation records are immutable'); END;
CREATE TRIGGER activation_records_no_delete BEFORE DELETE ON activation_records BEGIN SELECT RAISE(ABORT, 'activation records are immutable'); END;
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX login_tokens_expiry ON login_tokens(expires_at);
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  reset_at TEXT NOT NULL
);
