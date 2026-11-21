# Group 6 — Service requests and human concierge

This group completes the existing Express service request module and adds a separate, human-only concierge module. Groups 1–5, including bookings, Paystack verification, encrypted check-in and simulated room access, remain unchanged. The frontend continues to support its original standalone demo when NEXT_PUBLIC_API_URL is unset.

## Service catalogue

Seven original hotel service categories are seeded idempotently on first access. Each default category uses a stable seedKey, separate from its editable nameKey, so a manager's renamed or disabled default is preserved when the backend restarts.

- GET /api/v1/servicerequests/catalogue — public, lists active categories only; response array {id,name,description,active}
- GET /api/v1/servicerequests/catalogue/manage — manager only, includes inactive categories
- POST /api/v1/servicerequests/catalogue — manager only, JSON {name,description,active}; returns 201
- PATCH /api/v1/servicerequests/catalogue/:id — manager only, partial JSON of the same fields

Names are normalized and case-insensitively unique. Deactivation prevents new guest requests but preserves the original category name and status on previously submitted requests.

## Service requests

- POST /api/v1/servicerequests — guest only, JSON {bookingId,categoryId,details}. The API independently verifies ownership of a confirmed booking and checks whether today's Africa/Lagos local date is within check-in (inclusive) and checkout (exclusive). It also verifies that the category is active. Neither booking status, price, actor, guestId nor request status may be supplied by the browser.
- GET /api/v1/servicerequests/me — guest only, paginated own requests, optional status
- GET /api/v1/servicerequests — staff or manager only, paginated request queue, optional status
- PATCH /api/v1/servicerequests/:id/status — staff only, JSON {status:"in-progress"} or {status:"done"}

The request transitions received → in-progress → done. A conditional database update checks the expected previous status, so retries, skipped steps, and concurrent conflicting updates cannot produce duplicate history entries. Timestamps, the acting staff account, the original guest/booking, and status history are stored. Deleting or disabling a service category never deletes a request. Errors use the existing JSON {success,message,data} contract.

## Human concierge

- GET /api/v1/concierge/me — guest only, recent messages in the guest's own conversation, paginated
- POST /api/v1/concierge/me — guest only, JSON {text}, trimmed nonempty text up to 1000 characters
- GET /api/v1/concierge/conversations — staff only, paginated inbox with last-message sender, guest name, last-message timestamp, last-text preview and waiting-for-reply flag
- GET /api/v1/concierge/:guestId — staff only, messages for that guest, paginated
- POST /api/v1/concierge/:guestId — staff only, JSON {text}; only accepts an existing conversation with an active guest

The server derives the sender, sender display name, and guest owner from the logged-in account and/or a validated guest record. Requests cannot create AI/assistant messages or claim another role. Guest text is displayed as ordinary escaped React text, not interpreted as HTML. The concierge module is deliberately independent from future AI functionality, so Group 7 or later additions must not silently inject generated responses into human-only conversations. Guests may contact concierge without an active booking. Staff can reply to an existing guest conversation after checkout.

In API mode, only backend-provided live requests, catalogue entries, and messages are displayed. Legacy dataset-derived historical service records and local demo conversations remain separated and are not counted as live activity. The staff inbox is manually refreshable and polls periodically; it does not require WebSockets.

## QA and handoff

Backend tests cover guest identity, manager-only catalogue edits, booking ownership and active-stay eligibility, disabled categories, ordered status updates and history, guest-only messages, staff-only inbox and unauthorized/unsolicited replies. Frontend browser tests cover a verified active stay, a request through all status stages, manager catalogue editing, and a guest–staff conversation on a mobile-sized viewport, alongside the original preview, auth, booking/Paystack and check-in regressions.

CI tests use API fixtures and mocked Mongoose models; they do not represent hosted MongoDB or deployed-provider verification. Group 8 remains responsible for real database integration, concurrent update checks, hosted rate-limit and privacy checks, monitoring, final backend-developer deployment and the PDF handover. Do not add comments to new or modified code.
