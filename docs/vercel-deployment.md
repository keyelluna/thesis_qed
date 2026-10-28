# QED backend on Vercel

This deployment keeps the existing Hostinger MySQL database and the Vercel frontend.
The backend exports its Express app without starting a port listener or running
startup table creation in a Vercel function. Local `npm start` and Render retain
their server/socket startup. Existing database tables must already be migrated.

## 1. Create a separate backend project

Push only the prepared backend files (including the previously prepared Render
support diagnostics referenced by `server.js`):

```powershell
cd C:\Users\Mavys\Downloads\QED_System\thesis_qed
git add server.js config/db.js package.json package-lock.json src/operations/databaseTls.js src/modules/notification/notification.service.js vercel.json .vercelignore DEPLOYMENT_HANDOFF.md docs/vercel-deployment.md test/vercelDeployment.test.js src/operations/hostingNetworkDiagnostics.js test/hostingNetworkDiagnostics.test.js
git commit -m "Prepare QED backend for Vercel deployment"
git push origin main
```

Then in Vercel choose **Add New → Project** and import
`keyelluna/thesis_qed`, branch `main`. Use a different project from the frontend.
The repository owner should perform this import using their own connected Vercel
account. See [the co-developer handoff](../DEPLOYMENT_HANDOFF.md) for pull commands
and frontend/backend responsibilities.

- Framework: **Express** (automatic detection).
- Root directory: repository root.
- Node.js: **24.x**.
- Install command: `npm ci`.
- Build command: leave unset/default; this is JavaScript, with no compilation step.
- Output directory: leave unset/default.
- Use the Hobby/free plan and Fluid compute. Do not configure `PORT` for Vercel.
- Do not copy `RENDER=true` to Vercel; the Render-only support probe is not needed.

## 2. Backend environment variables

Copy the existing private values from Render's environment settings into Vercel's
environment settings. Never commit `.env` or share its contents in a chat.

Required for startup/login:

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DB_HOST` | `srv1040.hstgr.io` |
| `DB_PORT` | `3306` |
| `DB_NAME` | `u735951280_euc_qed` |
| `DB_USER` | `u735951280_qed` |
| `DB_PASSWORD` | Existing database password |
| `DB_TLS_MODE` | `verify-full` |
| `JWT_SECRET` | Existing private signing secret |
| `RESEND_API_KEY` | Existing private email API key; required by the mailer at import |

Also copy existing configured feature settings for email senders, Groq/YouTube,
and all `TEMPLATE_STORAGE_*` settings. The private template bucket remains external.
Do not enable mock password-reset settings in production. Vercel supplies `VERCEL=1`.

The two-connection pool is per function instance, not a global hosting limit.
Vercel's pool helper releases idle connections before suspension. Load-test before
using this configuration for a whole school.

## 3. Verify before switching the frontend

Open the new backend's `/health` (must return 200) and `/health/database` (must return
200 with `database: connected`). A 503 database result means the new provider still
cannot use the database; keep the current frontend target until that is resolved.
No health endpoint returns credentials. No public diagnostic endpoint is added.

## 4. Switch frontend only after database health passes

Push the accompanying frontend changes (API build guard and notification transport).
Use only these files; unrelated screenshots and reports are not part of the change:

```powershell
cd C:\Users\Mavys\Downloads\QED_System\QED_front_end
git add scripts/check-api-target.mjs scripts/tests/api-config.test.mjs scripts/tests/notification-transport.test.mjs src/shared/notification/Notification.service.ts
git commit -m "Support Vercel backend targets and notification polling"
git push origin main
```

On the existing **qed-front-end-6upk** Vercel project set:

```text
VITE_API_BASE_URL=https://YOUR-NEW-BACKEND.vercel.app
VITE_NOTIFICATION_TRANSPORT=polling
```

Use the exact HTTPS origin without `/api` or a trailing slash. Redeploy the frontend
so Vite embeds the new values. The build guard now verifies that configured target
instead of requiring Render's URL.

Notifications remain saved and refresh every 30 seconds; they are not instant
socket broadcasts on this deployment. The existing polling providers cover all
roles. No new realtime vendor or Redis account is required. Render/localhost keep
Socket.IO when `VITE_NOTIFICATION_TRANSPORT` is unset.

Keep the production frontend origin `https://qed-front-end-6upk.vercel.app`: existing
CORS/origin protection allows that exact site, not arbitrary Vercel preview URLs.
Login uses Secure/HttpOnly cookies. Use a fresh login on the new backend domain.

Verify login and Remember me, student reads, attendance saves, monthly PDF export,
grade-template access, notification refresh, and password recovery. Vercel's request
body limit also applies to uploads: existing 10MB workbook uploads may exceed it;
verify real template sizes before cutover. The function has a 60-second deadline.

## Rollback

Restore `VITE_API_BASE_URL=https://thesis-qed-1.onrender.com`, remove the polling
override, and redeploy the frontend. Keep the Render service until the replacement
has been validated. Switching providers does not guarantee a network timeout is fixed.
