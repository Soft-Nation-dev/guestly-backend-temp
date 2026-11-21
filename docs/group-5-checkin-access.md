# Group 5 — Secure check-in and simulated room access

This group completes the existing Express check-in and room-key modules. It preserves all prior booking and authentication behavior, including the frontend demo when NEXT_PUBLIC_API_URL is not configured.

## Guest and staff API

- POST /api/v1/checkins: authenticated guest, multipart form fields bookingId, arrivalTime (HH:MM), documentKind (Passport, National ID or Driver's licence), and document (JPEG, PNG or WebP; 2 MB maximum). Requires a confirmed, unfinished booking owned by the guest. Only a rejected submission may be resubmitted.
- GET /api/v1/checkins/me: authenticated guest, paginated, own sanitized check-in records.
- GET /api/v1/checkins: authenticated staff, paginated with optional status filter.
- PATCH /api/v1/checkins/:bookingId/review: authenticated staff, JSON body with approved boolean and note string. Rejections require a reason, and transitions only apply once to pending check-ins.
- GET /api/v1/checkins/:bookingId/document: authenticated staff only. Private, no-store, no-sniff image attachment. The guest and manager cannot download documents using this endpoint.
- GET /api/v1/roomkeys/:bookingId: authenticated guest owner only; returns bookingId, status, simulated:true, code or null, validFrom and expiresAt. Only an approved, confirmed and currently active booking returns a code.

## Privacy and security

Documents are encrypted before storage in MongoDB using AES-256-GCM. The dedicated CHECKIN_DOCUMENT_KEY is a cryptographically random 32-byte value encoded in base64 and held only in backend environment secrets. Do not commit the key or put it in any NEXT_PUBLIC_ variable. The backend refuses uploads when the key is missing or malformed and requires a valid key at production startup. Generate one with:

    node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

The check-in API returns status and history only. It never serves a public document URL, raw bytes, IV, authentication tag or access nonce. Downloads require a valid staff JWT and return an attachment rather than an inline public image. Uploaded filenames are discarded. Encrypted image bytes and crypto metadata are removed nightly, 30 days after checkout, while sanitized check-in status and review history remain. Database backups and document retention policies require equivalent protection and regular verification by the deployment owner.

Staff approvals create an access nonce in the same MongoDB transaction as the approval. The nonce is never returned by the API. The guest receives an on-demand HMAC-derived code prefixed SIM- only between local 14:00 on check-in date and 12:00 on checkout date, and only after approval. The code is deliberately simulated and does not interact with locks or real physical access systems. Pending, rejected, cancelled, unconfirmed, scheduled and expired stays cannot obtain an active code.

## Validation

Run npm test and the frontend workflow. Backend tests cover guest ownership, staff-only document downloads and review, file MIME/signature validation and size limit, AES-GCM authentication, audit transitions, expired access and document purging. Frontend API fixture tests cover guest ID uploads, staff rejection and approval, guest resubmission, protected downloads and simulation. Both CI pipelines should be green before merging.

The final Group 8 integration must also test MongoDB transactions on the deployed replica set, actual encrypted-document storage and retrieval, key backup/rotation policy, server HTTPS, file-size limits, privacy statements and stable handling of renewal/expiration. The backend developer deploys the API after the code is complete, and receives the deployment PDF in Group 8.
