ALTER TABLE game_rooms ADD COLUMN entry_amount_santim INTEGER NOT NULL DEFAULT 0 CHECK (entry_amount_santim >= 0);
ALTER TABLE game_rooms ADD COLUMN wallet_kind TEXT NOT NULL DEFAULT 'free' CHECK (wallet_kind IN ('free','real'));
