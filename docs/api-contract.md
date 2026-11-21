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
