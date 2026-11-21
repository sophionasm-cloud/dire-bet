# DIRE BET privacy notice — draft for legal review

**DRAFT — NOT APPROVED FOR PUBLICATION.** Prepared 2026-11-20. The owner and qualified counsel must confirm that this notice matches actual data handling and applicable law.

## Data handled by the application

Telegram sign-in sends Telegram `initData` to the Worker for signature and freshness checks. The app stores verified Telegram account details, display name, username, language, and any contact a user shares with the bot. Web sign-in is available to a linked account; its password is stored as a hash. Signed access tokens and rotating refresh tokens are kept in the browser's `localStorage`; refresh tokens are stored server-side only as keyed hashes, and logout revokes the session.

Free play does not require an age review. Real-money features remain disabled; before they can be enabled, the owner must select and document a suitable 18+ age-verification method and record the required legal and provider approvals. The app does not perform an identity-document or biometric check itself. Any age-eligibility result and supporting compliance evidence recorded for real-money activation is retained in D1 and audit logs.

While live-money features are locked, payment account details remain disabled. If the required legal and provider approvals are recorded and an administrator activates the system, users can submit Telebirr or eBirr deposit requests with an amount, transaction reference, sender phone number, and payment screenshot. Withdrawal requests include an amount, provider, destination phone, and account name. Contact fields and receipt images are encrypted before storage. Request status, manual review actions, transfer references, and wallet ledger entries are retained in D1. Paid-room holds, results, refunds, and payouts are also recorded in the ledger.

## Purposes, access and service providers

Account information supports sign-in and gameplay. Payment information supports manual deposit verification, withdrawal processing and financial reconciliation. Super Admins can review payment screenshots and withdrawal details; those values are decrypted only for the relevant review screens. Cloudflare hosts the Worker, D1 and static app when deployed. Telegram handles its platform data under its own policies.

## Retention, deletion and user requests

Deposit receipt rows currently receive a 365-day `retention_until` value, but automatic deletion at that date is not implemented. The owner and counsel must approve retention periods and complete a deletion process before money activation. Age-eligibility evidence retention, ledger retention, deletion requests, privacy contact and data-subject request handling also need an approved policy. The final service should delete personal information when no longer needed, subject to legal recordkeeping requirements.

## Security and changes

The app uses Telegram init-data verification, signed access tokens with hashed rotating refresh tokens, origin checks, rate limits, encrypted payment contact fields, and an append-only wallet ledger. This notice is still a draft; no production deployment or external security review was verified in this task. Privacy contact details are not configured.

Before launch, counsel must provide the effective date, controller identity, legal basis, data categories, age-check method, retention periods, user rights, transfer locations, contact details, complaint route and any consent language required by applicable law and Telegram terms.
