# Group 4 — Bookings, Paystack and audit trail

## Architecture

Keep the original Express modules and Mongoose schemas. Hotel and room catalogue services from Group 3 remain intact. This group adds the previously empty Booking model, routes, services and controllers; it supplements Payment and Paystack code instead of replacing the project.

Booking inventory is reserved for 15 minutes under a MongoDB transaction. Before checking overlapping bookings, the transaction writes the corresponding room document, making competing reservations for the same room type serialize and retry on MongoDB write conflicts. Active pending holds and confirmed bookings count toward the maximum simultaneous occupancy. Check-out is exclusive. Expired, cancelled and historical bookings do not consume inventory. Deployment must use MongoDB Atlas or another replica-set deployment supporting multi-document transactions. A standalone MongoDB without transaction support cannot safely create a hold.

Amounts stored in room documents and returned in the guest-facing booking API are whole NGN. Booking.totalAmount, Payment.amount, Paystack initialization and refunds use integer kobo (100 kobo = 1 NGN). Never accept price, guest role, paid status or payment success from client requests.

## API contract

- POST /api/v1/bookings: authenticated guest only; body {roomId,checkIn,checkOut,guests,requestId}. roomId is the stable room slug, requestId is a client-generated UUID reused on retries. Returns a pending hold and its expiresAt, total in NGN.
- GET /api/v1/bookings/me: guest only, paged, optional status.
- GET /api/v1/bookings: staff or manager, paged, optional status.
- GET /api/v1/bookings/:id: owner, staff or manager.
- POST /api/v1/bookings/:id/cancel: guest owner, pending holds only.
- POST /api/v1/payments/initialize: guest owner, pending unexpired booking only; body {bookingId}; server calls Paystack with the immutable booking amount and configured callback URL. Response includes https://checkout.paystack.com/... authorizationUrl, payment reference, kobo amount and hold expiry.
- GET /api/v1/payments/:reference/status: guest owner, staff or manager; independently checks Paystack for unsettled payments. Returns payment status, booking status, reference, amount (kobo), refund status and whether a refund is required.
- GET /api/v1/payments/me: guest payment history, paged.
- GET /api/v1/payments: manager-only payment history, paged.
- POST /api/v1/payments/:reference/refund: manager-only full refund request for a verified payment flagged refund_required. Only one outstanding request is accepted.
- POST /api/v1/payments/webhook: Paystack raw-body SHA512 signature validated before processing charge.success or refund.* notifications. All payment confirmation requires an additional server-to-server Paystack verification request.
- GET /api/v1/auditlogs: manager only; paged, optional bookingId.

Booking statuses: pending, confirmed, expired, cancelled. Payment statuses: pending, success, failed, abandoned, review_required, refund_required, refunded. Only verified matching charge.success with active hold creates a confirmed booking. A late, cancelled, duplicate or expired-hold payment is marked refund_required instead of promising a room. Transaction amount or currency mismatch becomes review_required. Refunds are initiated only by a manager; uncertain results require checking Paystack dashboard rather than retrying blindly. Paystack asynchronous refund webhooks update refund status and audit records.

The existing expiration cron marks expired holds every five minutes. Availability already excludes expired holds by deadline, so expiry does not wait for cron. Expiration never silently marks an unverified Paystack charge as paid, cancelled or refunded.

## Frontend and deployment

Set NEXT_PUBLIC_API_URL to the HTTPS backend origin when all phases are ready. Set PAYSTACK_CALLBACK_URL to https://soft-nation-dev.github.io/guestly/payment/return (or the canonical frontend production URL). Set the Paystack webhook URL in the provider dashboard to https://YOUR-BACKEND/api/v1/payments/webhook. Keep PAYSTACK_SECRET_KEY on the backend only; do not expose it through NEXT_PUBLIC_* variables. Test keys and live keys must not be mixed.

The standalone GitHub Pages demo retains simulated checkout when NEXT_PUBLIC_API_URL is unset. When the backend URL is configured, reservations, payments and statuses must use the backend and redirect to Paystack. Browser callbacks are never proof of payment; only GET payment status or the signed webhook can confirm.

## Testing and handover

CI runs mocked endpoints and payment-gateway verification, including permissions, kobo conversion, expiry, double-booking decisions, late charges and refund states. Before the final backend deployment, test against an actual MongoDB replica set and Paystack sandbox (including real signed webhooks, transaction retries and a duplicate booking race). No private keys or credentials are committed.

Do not start Groups 5–8 until Group 4 backend and frontend pull requests have passed their checks and merged. Group 8 still owns the final human-written PDF and the backend developer's hosted deployment.
