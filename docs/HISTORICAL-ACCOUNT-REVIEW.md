# Historical registration and session review

No production account, key, session or student record was modified or queried during preparation.

The official Render live deployment identified earlier is `dep-db51pegu01pc73fqqglg`, commit `6e2ae01800e384029f83eb2819030e59a522980e`. That commit's source exposes caller-selected-role registration without the newer Admin boundary. This establishes a deployed-code exposure requiring operator review; it is not proof of exploitation. Old registration can leave authentication records behind, and a privileged account with a matching profile can authenticate again even after JWT rotation.

The nine review commits close public registration and reject legacy/incomplete/reset-purpose sessions in HTTP and Socket.IO. A follow-up local correction now applies the same checks to **audit actor attribution**, which previously accepted legacy `id` and default JWT algorithms. Audit attribution is not itself route authorization, but must not label an invalid session as a trusted actor.

## Safe owner procedure

1. Record deployment/exposure dates and preserve access/deployment/audit evidence privately. Do not create a test account through production registration.
2. Arrange a verified backup/restore plan with the database owner. Backup handling involves sensitive school data and requires an approved encrypted destination and access controls; no backup was taken here.
3. Review `scripts/audit/production-readonly-checks.sql` with a least-privilege read-only account. It selects metadata and aggregates only, never hashes, reset codes, contacts or student rows. A missing older table is a finding; do not initialize it as part of the audit.
4. The authorized school owner must reconcile privileged account provenance and orphan/duplicate counts against independently approved administrative records inside the protected environment. Counts alone cannot identify an unauthorized person. Do not export rosters or authentication rows into chat/logs.
5. Escalate suspected accounts for a separate remediation decision. Do not automatically delete, disable or merge records, change grades or repoint parent links.
6. Recommend a coordinated JWT rotation after the vulnerable route is closed on **every** serving backend and account provenance is resolved. Rotate only after explicit approval, across all services at the agreed time. This forces sign-in and invalidates outstanding reset tokens. New claim validation does not revoke valid already-issued normal tokens, and rotation alone does not remove unauthorized persistent accounts.
7. Do not roll back to a compromised key. If emergency code rollback restores old public registration, contain that exposure under a separately approved operational plan.

## Rate-limiting activation still requires approval/evidence

`loginThrottle.js` is a tested deployment-neutral core, **not mounted on login**. It requires an atomic shared store, a client-IP resolver and an account normalizer; it never reads forwarding headers itself. Its proposed policy reserves both account/IP buckets atomically, counts concurrent in-flight attempts, limits 10/account and 100/IP per 15 minutes, and does not charge the school IP for requests already blocked by an account limit. Successful authentication resets that account's failures without clearing other IP failures.

An in-memory test double verifies behavior; it is not a durable production adapter. No gateway/Redis credentials were found in the inspected service key lists. Confirm all serving services/processes, an existing shared store or approved new infrastructure, proxy header replacement/hop trust, MySQL username normalization/collation, counter TTL/cardinality bounds, and store-outage behavior before mounting the core. Choose fail-open versus temporary 503 explicitly; do not silently make that availability/security decision. Production login remains unthrottled until activation is approved and tested.
