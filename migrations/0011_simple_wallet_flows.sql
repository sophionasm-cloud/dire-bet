ALTER TABLE deposit_requests ADD COLUMN sms_sha256 TEXT;
ALTER TABLE deposit_requests ADD COLUMN review_flags TEXT;

ALTER TABLE payment_settings ADD COLUMN withdrawal_minimum_santim INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE payment_settings ADD COLUMN withdrawal_maximum_santim INTEGER NOT NULL DEFAULT 1000000;

CREATE UNIQUE INDEX deposits_sms_sha256_once
  ON deposit_requests(sms_sha256) WHERE sms_sha256 IS NOT NULL;
