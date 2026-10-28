# QED Vercel backend deployment handoff

## Current status

The backend is prepared for a **separate Vercel Express project** using the existing
Hostinger database. It has not yet been deployed to Vercel. Render is still the
current backend and its database connection times out from Render's network.
Local connections to the same Hostinger database work. A provider change must be
verified; it is not a confirmed fix yet.

Read [the complete deployment instructions](docs/vercel-deployment.md).

## For the backend repository owner

After the handoff changes have been pushed to `main`, in your existing backend clone:

```bash
git switch main
git pull --ff-only origin main
npm ci
```

If Git reports local changes or diverged history, stop and reconcile those changes
instead of discarding them. No database export/import is needed for this deployment.

Use your own Vercel account connected to your GitHub account to import
`keyelluna/thesis_qed`. Vercel Hobby has repository-owner/commit-author restrictions;
if it rejects a collaborator-authored deployment, use the owner's normal review
and merge workflow. Do not change commit authorship or share account passwords.

### Vercel project settings

| Setting | Value |
| --- | --- |
| Plan | Hobby/free |
| Framework | Express |
| Root directory | Repository root |
| Production branch | `main` |
| Node version | 24.x |
| Install command | `npm ci` |
| Build / output directory | Leave unset/default |

The required environment-variable names and database host are in the deployment
guide. Copy secret values directly from the existing Render settings into Vercel.
Do not copy Render's `PORT` or `RENDER=true`. Keep database TLS verification enabled.
Set `NODE_ENV=production`; never copy local password-reset test overrides.

### Code changes included

- `server.js` exports the Express app; Vercel does not start a port listener or
  run the startup table-creation batch. Existing database tables must be present.
- Small reusable MySQL pool with Vercel idle-connection management and verified TLS.
- Runtime SQL files and mailer images are included in the function bundle.
- Vercel notifications are persisted and read through HTTP; the frontend must use
  its existing 30-second refresh instead of connecting to process-local Socket.IO.
- Render/localhost keep the port listener and Socket.IO behavior.
- Earlier Render-only network support diagnostics are included; they do not run
  on Vercel unless `RENDER=true` is incorrectly copied there.

### Verification and return information

Before asking the frontend owner to switch:

1. Deploy the backend and check `/health`: expect HTTP 200.
2. Check `/health/database`: expect HTTP 200 and `database: connected`.
3. If database health fails, capture the sanitized Vercel function error and keep
   the frontend unchanged. Do not disable TLS or rotate working credentials to
   troubleshoot a TCP timeout.
4. Send the frontend owner the backend HTTPS origin, deployed commit, health-check
   results, and any unresolved deployment errors. No credentials are needed in that reply.

The frontend owner will then test login, attendance writes, exports, templates,
password recovery, and notifications from the approved production frontend origin.
An unauthenticated `/health` success alone does not mean login works.

## Coordination with the frontend owner

Companion frontend edits are in the separate `QED_front_end` repository and must
be committed/pushed separately. They are not delivered by pulling this repository.
They make the build guard accept a configured Vercel backend and support polling.

Only after database health passes, set these on **qed-front-end-6upk** and redeploy:

```text
VITE_API_BASE_URL=https://NEW-BACKEND.vercel.app
VITE_NOTIFICATION_TRANSPORT=polling
```

Use the backend origin only, without `/api` or a trailing slash. Existing CORS
permits `https://qed-front-end-6upk.vercel.app`, not arbitrary preview domains.

Notifications refresh every 30 seconds on this setup. Existing workbook upload
validation permits 10 MB, but Vercel's function request limit can reject uploads
over 4.5 MB before Express runs; confirm real workbook sizes before cutover.

## Validation already completed locally

- 87 startup, database/TLS, reliability, and diagnostic tests passed.
- 198 authentication, cookie/session, origin, notification, and template-storage tests passed.
- 15 frontend API-target and notification-transport tests passed.
- Frontend production build, API-target guard, bundle budget, and ExcelJS checks passed.
- Actual exported backend served `/health` locally in Vercel mode.

Live Vercel-to-Hostinger connectivity and end-to-end behavior remain to be verified
after deployment. Keep the Render service available for rollback.
