UPDATE payment_settings
SET account_label = NULL, account_number = NULL, enabled = 0
WHERE account_number = '0956870660' AND COALESCE(account_label, '') = '' AND updated_by IS NULL;

ALTER TABLE withdrawal_requests ADD COLUMN payment_reference TEXT;
CREATE UNIQUE INDEX withdrawal_payment_reference_once ON withdrawal_requests(provider, payment_reference) WHERE payment_reference IS NOT NULL;

CREATE TRIGGER real_withdrawal_balance_check
BEFORE INSERT ON withdrawal_requests
WHEN NEW.wallet_kind = 'real'
BEGIN
  INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
  VALUES ('real-' || NEW.user_id, NEW.user_id, 'real', 0);
  SELECT CASE WHEN (SELECT balance_santim FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'real') < NEW.amount_santim
    THEN RAISE(ABORT, 'insufficient_wallet_balance') END;
END;

CREATE TRIGGER real_withdrawal_reserve
AFTER INSERT ON withdrawal_requests
WHEN NEW.wallet_kind = 'real'
BEGIN
  INSERT INTO wallet_transactions
    (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
  SELECT lower(hex(randomblob(16))), id, 'real', 'expense', -NEW.amount_santim,
    balance_santim - NEW.amount_santim, 'withdrawal-hold:' || NEW.id, 'user', CAST(NEW.user_id AS TEXT), NEW.id
  FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'real';
END;

CREATE TRIGGER real_deposit_credit
AFTER UPDATE OF status ON deposit_requests
WHEN OLD.status IN ('pending', 'needs_info') AND NEW.status = 'approved' AND NEW.wallet_kind = 'real'
BEGIN
  INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
  VALUES ('real-' || NEW.user_id, NEW.user_id, 'real', 0);
  INSERT INTO wallet_transactions
    (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
  SELECT lower(hex(randomblob(16))), id, 'real', 'deposit', NEW.amount_santim,
    balance_santim + NEW.amount_santim, 'deposit-credit:' || NEW.id, 'admin', NEW.reviewed_by, NEW.id
  FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'real';
END;

CREATE TRIGGER real_withdrawal_refund
AFTER UPDATE OF status ON withdrawal_requests
WHEN OLD.status IN ('pending', 'reviewing', 'approved') AND NEW.status = 'rejected' AND NEW.wallet_kind = 'real'
BEGIN
  INSERT INTO wallet_transactions
    (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
  SELECT lower(hex(randomblob(16))), id, 'real', 'refund', NEW.amount_santim,
    balance_santim + NEW.amount_santim, 'withdrawal-refund:' || NEW.id, 'admin', NEW.reviewed_by, NEW.id
  FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'real';
END;

CREATE TRIGGER audit_real_deposit_review
AFTER UPDATE OF status ON deposit_requests
WHEN OLD.status != NEW.status AND NEW.wallet_kind = 'real'
BEGIN
  INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
  VALUES (lower(hex(randomblob(16))), 'admin', NEW.reviewed_by,
    'WALLET_DEPOSIT_' || upper(NEW.status), 'deposit_request', NEW.id,
    json_object('status', OLD.status), json_object('status', NEW.status, 'reason', NEW.review_reason));
END;

CREATE TRIGGER audit_real_withdrawal_review
AFTER UPDATE OF status ON withdrawal_requests
WHEN OLD.status != NEW.status AND NEW.wallet_kind = 'real'
BEGIN
  INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
  VALUES (lower(hex(randomblob(16))), 'admin', NEW.reviewed_by,
    'WALLET_WITHDRAWAL_' || upper(NEW.status), 'withdrawal_request', NEW.id,
    json_object('status', OLD.status), json_object('status', NEW.status, 'reason', NEW.review_reason, 'paymentReference', NEW.payment_reference));
END;
