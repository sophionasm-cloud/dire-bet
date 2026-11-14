# DIRE BET privacy notice — draft for legal review

**DRAFT — NOT APPROVED FOR PUBLICATION.** Prepared 2026-11-15. The owner and qualified counsel must confirm that this notice matches actual data handling and applicable law.

## Current preview data

If a user opens the app in Telegram, it can submit Telegram’s raw `initData` to the Worker for signature and freshness validation. The Worker uses only the verified Telegram user details to create or update a D1 user record and issues a short-lived session token held in page memory. A normal browser guest can browse and play local XO practice; guest practice does not create a server match record.

The database schema also defines future tables for rooms, matches, wallets and support, but those services are not enabled. The schema itself does not mean those data flows currently operate. No payment details, bank credentials, PINs, voice recordings or receipts are requested by the preview.

## Purposes and sharing

Verified Telegram profile fields are used for basic account identification and language selection. Cloudflare would host Worker, D1 and static app data if the owner deploys this code. Telegram handles its own platform data under its policies. No analytics or advertising vendor has been configured in this preview.

## Retention, deletion and user requests

The owner has not yet approved a retention schedule, deletion process, privacy contact or data-subject request process. Those items must be set before public launch. The final service should collect only the information needed, delete it when no longer needed subject to law, and document legal exceptions.

## Security and changes

The preview uses HTTPS when deployed by Cloudflare, Telegram init-data verification and short-lived signed sessions. Security review is incomplete; no production deployment has been verified. Contact details for privacy questions are not configured.

Before launch, counsel must provide the effective date, controller identity, legal basis, data categories, age information, retention periods, user rights, transfer locations, contact details, complaint route and any consent language required by applicable law and Telegram terms.
