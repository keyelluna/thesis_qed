# Disposable local MySQL verification

No disposable database was available at preparation time. Docker and mysql commands were not found on this host. Nothing was installed, started, connected or migrated. The files below are a prepared setup, not evidence of completed real-MySQL testing.

## Isolation contract

Use only a newly created local container/database containing synthetic data. The compose file publishes **127.0.0.1:3307**, creates **qed_release_test**, and uses a **qed_test** user scoped to that database. It does not mount production backups, credentials, workbooks or application uploads. The CLI refuses other hosts, ports, databases, users, or absent explicit confirmation; DB_HOST/DB_NAME cannot substitute. Network access in the runner is restricted to the fixture endpoint.

The schema is a targeted release fixture, not a production migration or complete school database. It covers provisioning metadata, formal availability and template-version prerequisites. Full Teacher submission/persistence and production date/collation equivalence still require extending the fixture against the owner's approved schema inventory. Never run this schema against production or an existing school database.

## Owner setup after approving a local Docker installation

1. Install/start Docker Desktop through your normal approved process. Confirm port 3307 is unused and the named volume is new. Do not reuse an unknown existing volume.
2. Create ignored `thesis_qed/.env.test.local` privately with these names. Choose two unique disposable passwords locally; do not paste them into chat or Git:

```dotenv
QED_TEST_MYSQL_CONFIRM=SYNTHETIC_LOCAL_ONLY
QED_TEST_MYSQL_HOST=127.0.0.1
QED_TEST_MYSQL_PORT=3307
QED_TEST_MYSQL_DATABASE=qed_release_test
QED_TEST_MYSQL_USER=qed_test
QED_TEST_MYSQL_PASSWORD=
QED_TEST_MYSQL_ROOT_PASSWORD=
```

3. Review the official `mysql:8.4` image and record its resolved digest. The local image uses UTF-8/InnoDB; compare target production version, collation and SQL mode before treating it as representative.
4. From the backend root, manually run:

```powershell
docker compose --env-file .env.test.local -f scripts/testing/mysql/compose.yaml up -d --wait
node scripts/testing/mysql/run.cjs
```

The opt-in runner checks table engines, cross-connection named locks, real concurrent atomic account creation (exactly one 201 and one 409), and actual formal-release SQL. Mail is doubled; no production environment file is loaded. One synthetic Teacher account is retained per run; grade fixtures are rolled back. The script does not delete existing records. Output contains only test statuses/counts, no credentials or identities.

To stop the local container without deleting data, use `docker compose --env-file .env.test.local -f scripts/testing/mysql/compose.yaml stop`. Do not run reset, volume deletion or cleanup against any unverified target.

## Still pending until this fixture is approved and running

- Execute the runner and validate initial schema syntax against actual MySQL 8.4.
- Extend tests for sectionless submissions, all eight gates with real SQL/date behavior, parent link scope, real commit/rollback/retry failure cases, and password recovery concurrency.
- Exercise pinned templates across newer uploads and storage failures using synthetic workbooks and a fake object adapter; never repin historical production terms.
- Extend the schema for the existing opt-in full gradebook harness and verify Teacher score/submission/cache persistence and Parent publication end to end. Do not point that older harness at production; it loads `.env` by default.
- Verify production-version/engine/collation/SQL-mode equivalence using owner-approved metadata only.

The target-guard unit tests are executable without MySQL and reject production destinations. They do not establish real SQL or transaction correctness.
