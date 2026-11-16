UPDATE games SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN ('ludo', 'dominoes', 'poker');
