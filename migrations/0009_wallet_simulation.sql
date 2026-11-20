ALTER TABLE deposit_requests ADD COLUMN simulation_only INTEGER NOT NULL DEFAULT 0 CHECK (simulation_only IN (0,1));
ALTER TABLE deposit_requests ADD COLUMN receipt_sha256 TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN simulation_only INTEGER NOT NULL DEFAULT 0 CHECK (simulation_only IN (0,1));

CREATE UNIQUE INDEX deposits_receipt_sha256_once
  ON deposit_requests(receipt_sha256) WHERE receipt_sha256 IS NOT NULL;

CREATE TRIGGER simulated_deposit_credit
AFTER UPDATE OF status ON deposit_requests
WHEN OLD.status IN ('pending','needs_info') AND NEW.status = 'approved'
  AND NEW.wallet_kind = 'demo' AND NEW.simulation_only = 1
BEGIN
  INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
    VALUES ('demo-' || NEW.user_id, NEW.user_id, 'demo', 0);
  INSERT OR IGNORE INTO wallet_transactions
    (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
  SELECT lower(hex(randomblob(16))), id, 'demo', 'deposit', NEW.amount_santim,
    balance_santim + NEW.amount_santim, 'simulation-deposit-credit:' || NEW.id, 'admin', NEW.reviewed_by, NEW.id
  FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'demo';
END;

CREATE TRIGGER simulated_withdrawal_balance_check
BEFORE INSERT ON withdrawal_requests
WHEN NEW.wallet_kind = 'demo' AND NEW.simulation_only = 1
BEGIN
  INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
    VALUES ('demo-' || NEW.user_id, NEW.user_id, 'demo', 0);
  SELECT CASE WHEN (SELECT balance_santim FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'demo') < NEW.amount_santim
    THEN RAISE(ABORT, 'insufficient_simulation_balance') END;
END;

CREATE TRIGGER simulated_withdrawal_reserve
AFTER INSERT ON withdrawal_requests
WHEN NEW.wallet_kind = 'demo' AND NEW.simulation_only = 1
BEGIN
  INSERT INTO wallet_transactions
    (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
  SELECT lower(hex(randomblob(16))), id, 'demo', 'expense', -NEW.amount_santim,
    balance_santim - NEW.amount_santim, 'simulation-withdrawal-hold:' || NEW.id, 'user', CAST(NEW.user_id AS TEXT), NEW.id
  FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'demo';
END;

CREATE TRIGGER simulated_withdrawal_refund
AFTER UPDATE OF status ON withdrawal_requests
WHEN OLD.status IN ('pending','reviewing','approved') AND NEW.status = 'rejected'
  AND NEW.wallet_kind = 'demo' AND NEW.simulation_only = 1
BEGIN
  INSERT INTO wallet_transactions
    (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
  SELECT lower(hex(randomblob(16))), id, 'demo', 'refund', NEW.amount_santim,
    balance_santim + NEW.amount_santim, 'simulation-withdrawal-refund:' || NEW.id, 'admin', NEW.reviewed_by, NEW.id
  FROM wallets WHERE user_id = NEW.user_id AND wallet_kind = 'demo';
END;

CREATE TRIGGER audit_simulated_deposit_review
AFTER UPDATE OF status ON deposit_requests
WHEN OLD.status != NEW.status AND NEW.wallet_kind = 'demo' AND NEW.simulation_only = 1
BEGIN
  INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
  VALUES (lower(hex(randomblob(16))), 'admin', NEW.reviewed_by,
    'WALLET_SIMULATION_DEPOSIT_' || upper(NEW.status), 'deposit_request', NEW.id,
    json_object('status', OLD.status), json_object('status', NEW.status, 'reason', NEW.review_reason, 'simulationOnly', 1));
END;

CREATE TRIGGER audit_simulated_withdrawal_review
AFTER UPDATE OF status ON withdrawal_requests
WHEN OLD.status != NEW.status AND NEW.wallet_kind = 'demo' AND NEW.simulation_only = 1
BEGIN
  INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
  VALUES (lower(hex(randomblob(16))), 'admin', NEW.reviewed_by,
    'WALLET_SIMULATION_WITHDRAWAL_' || upper(NEW.status), 'withdrawal_request', NEW.id,
    json_object('status', OLD.status), json_object('status', NEW.status, 'reason', NEW.review_reason,
      'paymentReference', NEW.payment_reference, 'simulationOnly', 1));
END;
