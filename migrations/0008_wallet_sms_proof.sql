ALTER TABLE deposit_requests ADD COLUMN proof_method TEXT NOT NULL DEFAULT 'receipt' CHECK (proof_method IN ('receipt','sms'));
ALTER TABLE deposit_requests ADD COLUMN confirmation_sms_ciphertext TEXT;
