# Guestly API foundation

The existing Express app remains the API host. The versioned application endpoints use `/api/v1`, and the existing health endpoint is `GET /health`.

## Environment

The backend uses `.env` locally, following `.env.example`. Run the backend on port `4000` alongside the Next.js frontend on `3000`. MongoDB and a JWT secret are required to start the server. Production also currently requires the Paystack secret configured by the backend's existing environment validation.

`CORS_ORIGINS` is a comma-separated list of **origins**, not URL paths. For GitHub Pages, use `https://soft-nation-dev.github.io`, not `https://soft-nation-dev.github.io/guestly/`. Add only actual frontend origins, including local development addresses.

No API secret belongs in the frontend or its public `NEXT_PUBLIC_*` variables.

## Response contract

Successful requests use `{ "success": true, "message": "...", "data": ... }`. Some successful responses may omit `data`. Failures use `{ "success": false, "message": "..." }` and an appropriate HTTP status.

The health response is:

```json
{
  "success": true,
  "message": "Service is healthy",
  "data": { "status": "ok", "database": "connected" }
}
```

A reachable server may report `"database": "disconnected"`; this does not indicate a usable database connection.

Existing authentication endpoints under `/api/v1/auth` are `POST /register`, `POST /login` and `GET /me`. Login returns `data.token` and `data.user`; protected routes use `Authorization: Bearer <token>`. Existing registration currently accepts `firstName`, `lastName`, `email`, `password` and `confirmPassword`. Role and account-management alignment is scheduled for Group 2.

Payments already have a partial implementation. The other hotel modules remain placeholders. Their contracts will be agreed and tested in their respective groups rather than inventing endpoints at this stage.

## Frontend integration

The frontend uses `NEXT_PUBLIC_API_URL` for the **backend origin**, for example `http://localhost:4000`. It calls `/health` and versioned endpoints under `/api/v1`. The URL is intentionally unset on GitHub Pages for now, so existing demonstration features remain unchanged until the API is deployed and integrated.

To verify the backend locally, run `npm test` from the backend repository. Tests exercise the actual Express app, health response, allowed/disallowed CORS origins, browser preflight and response error format without needing a live MongoDB server.

Live cross-origin verification against a hosted backend and the complete deployment instructions are reserved for the final integration and handover.


## Group 2: authentication and team accounts

The original Express user and auth modules remain the source of truth. Public registration always creates a guest account, regardless of any extra role field in the request. User role and activity are verified against MongoDB on every authorized request.

- POST /api/v1/auth/register: firstName, lastName, email, password, confirmPassword; returns guest account metadata.
- POST /api/v1/auth/login: email, password; returns { token, user }.
- GET /api/v1/auth/me: authenticated profile.
- PATCH /api/v1/auth/me: firstName, lastName, optional phone; cannot change permissions.
- POST /api/v1/auth/logout: invalidates the user's existing JWT sessions.
- GET /api/v1/users/team: admin only; returns staff and manager profiles.
- POST /api/v1/users/team: admin only; accepts firstName, lastName, email, password, confirmPassword and role (staff or manager).
- PATCH /api/v1/users/team/:id/access: admin only; accepts { role: "staff" | "manager", isActive: boolean }.

Successful profile responses include { id, firstName, lastName, email, phone, role, isActive }; no response includes a password hash.

Admin provisioning is deliberately not exposed as a public API route. After setting the MongoDB, JWT and (if required by environment validation) Paystack variables, the backend developer should set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12-72 characters), optionally first and last name, then run:

    npm run bootstrap:admin

The bootstrap command refuses to create another super admin if one exists and never prints credentials. Do not commit real bootstrap values, JWT secrets or production keys. Remove bootstrap credentials from the runtime environment after creating the admin.

JWTs include a sessionVersion, checked against MongoDB. Logout, role changes and account deactivation invalidate the relevant JWTs. Tokens are sent in Authorization headers and have the configured JWT_EXPIRES_IN lifetime. Frontend session storage is used only in live-API mode; when NEXT_PUBLIC_API_URL is unset the existing local preview is preserved.

Backend CI exercises registration, login, role checks, team provisioning, revocation, profile updates and token expiry with the existing Express app. Live MongoDB/browser integration and hosted secret verification are still required in the final handover group.
