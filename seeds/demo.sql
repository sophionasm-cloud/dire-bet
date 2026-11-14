INSERT OR IGNORE INTO users (telegram_id, username, first_name, language) VALUES
  (999000001, 'demo_player_one', 'Demo Player', 'en'),
  (999000002, 'demo_player_two', 'Practice Friend', 'am'),
  (999000003, 'demo_agent_player', 'Agent Preview', 'so');
INSERT OR IGNORE INTO user_profiles (user_id, display_name, age_eligibility)
  SELECT id, first_name, 'unverified' FROM users WHERE telegram_id BETWEEN 999000001 AND 999000003;
INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
  SELECT 'demo-' || telegram_id, id, 'demo', 100000 FROM users WHERE telegram_id BETWEEN 999000001 AND 999000003;
INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
  SELECT 'promo-' || telegram_id, id, 'promo', 0 FROM users WHERE telegram_id BETWEEN 999000001 AND 999000003;
INSERT OR IGNORE INTO game_rooms (id, code, game_id, host_user_id, status, capacity, mode)
  SELECT 'demo-room-001', 'DEMO01', 'xo', id, 'finished', 2, 'practice' FROM users WHERE telegram_id = 999000001;
INSERT OR IGNORE INTO matches (id, room_id, game_id, status, bot_match, started_at, ended_at, result_json)
  VALUES ('demo-match-001', 'demo-room-001', 'xo', 'completed', 1, datetime('now','-2 hours'), datetime('now','-2 hours','+4 minutes'), '{"result":"win","demo":true}');
INSERT OR IGNORE INTO match_players (match_id, user_id, seat, result) SELECT 'demo-match-001', id, 1, 'win' FROM users WHERE telegram_id = 999000001;
INSERT OR IGNORE INTO match_players (match_id, user_id, seat, bot_label, result) VALUES ('demo-match-001', NULL, 2, 'BOT', 'loss');
