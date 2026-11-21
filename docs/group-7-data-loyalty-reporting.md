# Group 7 — Historical import, verified loyalty, recommendations and reports

The historical Data Analyst dataset is not a verified Paystack ledger. It remains a distinct archival source. This group does not import historical guest identities into the live User collection, change existing bookings/payment records or award points for historical rows. All implementation extends the existing Express/Mongoose backend while retaining the frontend's standalone GitHub Pages demonstration when NEXT_PUBLIC_API_URL is not configured.

## Data validation and import

The original files were preserved byte-for-byte at data/historical/bookings.json, guests.json, payments.json and service-requests.json. They contain 500 bookings, 431 guest rows, 500 payments and 500 service records (1,931 total source rows). The guest source has only 171 distinct Guest_ID strings and 135 IDs have conflicting attribute profiles. A repeated Guest_ID is **not** a unique person or a safe account lookup. Each source guest row is stored under its original Guest_ID plus unique source row index; all other source IDs are unique within their source. The original date, revenue, status, booking and payment identifiers are immutable.

Run, without connecting to MongoDB:

    npm run import:historical

This performs validation and prints a dry-run report, including conflicting guest IDs and historical source-status totals, with **zero** database writes. If it passes, the backend deployment owner may explicitly apply the import against the configured MongoDB database:

    npm run import:historical -- --apply

The importer validates all 4 arrays, identifier formats, legitimate calendar dates, nights, room and total revenue arithmetic, ID uniqueness, booking↔payment/guest references, payment status and amount consistency, and service-request booking/guest references. It aborts on malformed or mismatched source rows before touching MongoDB. The import uses unique (source,rowKey) and (source,sourceRow) indexes, $setOnInsert idempotent bulk upserts and checks existing payload hashes to detect source mutations. It never writes to operational User, Booking, Payment or ServiceRequest collections, never creates Paystack references, and never awards loyalty. Re-running unchanged sources inserts nothing. A changed source should be handled as a deliberate new dataset version through a reviewed migration, not overwritten silently.

There is no claim that the historical 'Successful' payment status was independently confirmed with Paystack. Archival revenue is labelled by original source status and never added to verified live revenue. A production import requires backup, access review and a proper migration window; it is not run automatically on backend startup.

## Reporting API

- GET /api/v1/reports/overview — authenticated manager only; returns data.historical and data.live separately.
- GET /api/v1/reports/historical/:source — authenticated manager only; :source one of bookings, guests, payments, service-requests; query page (1+), limit (1–100), q (source-ID search), optional status for bookings/payments.

The historical section includes original status splits, monthly source-reported successful values, service performance, room categories, number of source guest rows, number of distinct guest IDs and number of conflicting IDs. With no import, imported=false and zeros are shown; the frontend never silently substitutes bundled demo data for an unavailable live backend.

The live section counts actual confirmed reservations, gateway-success NGN payments in integer kobo, verified revenue as kobo divided by 100, service requests/completions, room inventory and credited live loyalty points. Historical and live numbers are never combined into a single revenue, payment or guest count. API responses use existing success/message/data envelopes and no-store headers.

The manager-facing historical source-record lists use backend pagination. Live mode never maps historical Guest_ID to the logged-in guest, even for IDs that look similar. Demo mode continues to display the bundled sample dataset separately, explicitly as test/preview records.

## Verified-stay loyalty API and accrual

- GET /api/v1/loyalty/me — guest only; own points balance, original live booking references and paginated history.
- GET /api/v1/loyalty/manager — manager only; aggregate balance and paginated live award records.
- GET /api/v1/loyalty/rules — manager only; historical earning rules in effective-date order.
- POST /api/v1/loyalty/rules — manager only; whole-number pointsPerNight 0–10,000 for future qualifying checkouts.
- POST /api/v1/loyalty/reconcile — manager only; idempotently reconciles eligible live bookings (also scheduled each day at 13:15 Africa/Lagos).

For each award, ALL conditions must hold:
1. A real backend booking belongs to the guest, is confirmed, and has passed checkout at 12:00 Africa/Lagos.
2. The live CheckIn record for the same booking/guest was manually approved by staff.
3. The referenced Payment has status success, correct guest and booking references, NGN currency and exact server-calculated integer-kobo amount.
4. The stay has a valid 1–365-night length and a historical earning rule effective at checkout.

LoyaltyAward has a unique index on Booking, preventing duplicate points under repeated requests. Award points/rate are stored at posting time and never backdated or repriced when managers change future rules. Active awards can be marked revoked when current booking/payment/check-in eligibility no longer holds; revoked awards do not count towards the balance and are not silently issued again. Reconciliation writes an audit event for new/revoked points. No imported historical row or payment status qualifies on its own.

## Recommendations API

GET /api/v1/recommendations/me — guest only, optional limit 1–6, returns room summary, score, human-readable reason, provenance and availabilityConfirmed=false. Personal preferences are computed only from the authenticated guest's live confirmed bookings matched to successful gateway payments; archive data contributes only aggregate category popularity, never guest identity or inferred payment verification. Featured rooms and current room catalogue remain fallback signals. All suggested rooms require fresh availability search before booking.

## QA and final handoff

Run npm test: import integrity, contradictory Guest_ID rows, dry-run, apply idempotence, tampering, role restrictions, absence of awards for pending/failed/unapproved bookings, post-checkout accrual, duplicate prevention, revocation, archive/live reporting isolation, and recommendation provenance.

Frontend CI also runs the original static-site demo plus live authentication, bookings/Paystack, check-in, services/concierge and new Group 7 mobile-width reports/loyalty/recommendation browser coverage.

Group 8 (backend developer): verify the actual MongoDB replica-set indexes and transactional behavior, upload and document retention, backup and source import, Paystack sandbox signed webhooks and refunds, HTTPS/CORS, rate limits, secrets, hosted reporting aggregation/performance, scheduled loyalty run, data-quality policy and audit trails. Backend deployment and the final PDF handover are postponed until Group 8. Do not add comments to modified source code.
