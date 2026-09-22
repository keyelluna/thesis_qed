const mysql = require("mysql2");

<<<<<<< HEAD
const STALE_CONNECTION_SECONDS = 60; 
const POOL_CONNECTION_LIMIT = 2; 
=======
// -----------------------------------------------------------------------
// WHY THIS FILE LOOKS THE WAY IT DOES
//
// Your MySQL user has max_user_connections = 5 (a hosting-plan limit, not
// something we control). We were hitting that ceiling because:
//   1. Nothing stopped two pools from existing in the same Node process
//      at once (e.g. a bad hot-reload, or a require() happening twice
//      before module caching kicked in).
//   2. Old connections from crashed/overlapping processes were sitting
//      idle ("Sleep") for minutes, silently eating slots that never got
//      freed until someone manually ran KILL in phpMyAdmin.
//
// The fixes below address both directly:
//   - A global singleton so only one pool can ever exist per process.
//   - A one-time startup sweep that finds and kills THIS USER's own
//     stale idle connections (the same manual cleanup you just did by
//     hand), so every restart self-heals instead of accumulating leaks.
//   - Error/connection logging so a leak is visible in logs instead of
//     silently reproducing this exact incident.
//
// ALSO ADDED (ECONNRESET fix):
//   - TCP keep-alive with an early first probe, so the host/network is
//     less likely to silently drop a quiet connection.
//   - A one-time retry for SELECT queries that fail because a pooled
//     connection was already dead (ECONNRESET etc.). mysql2 discards the
//     dead connection, so the retry runs on a fresh one. Writes are never
//     retried, to avoid running an INSERT/UPDATE twice.
// -----------------------------------------------------------------------

const STALE_CONNECTION_SECONDS = 60; // idle longer than this = safe to kill
const POOL_CONNECTION_LIMIT = 2; // lowered from 3 for more headroom under the 5-connection cap
>>>>>>> d15e8f0cbc56e99e49754dfc5788d5b61866cb31

// Errors that mean "the connection was already dead", not "the query is bad".
const DEAD_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
  "EPIPE",
]);

function isSelectQuery(firstArg) {
  const sql = typeof firstArg === "string" ? firstArg : firstArg && firstArg.sql;
  return typeof sql === "string" && /^\s*select\b/i.test(sql);
}

function createPool() {
  const pool = mysql
    .createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      timezone: "+08:00",
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: POOL_CONNECTION_LIMIT,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000, // first keep-alive probe after 10s idle
      connectTimeout: 10000, // fail fast if the DB host can't be reached
      charset: 'utf8mb4' 
    })
    .promise();

    pool.on("error", (err) => {
    console.error("MySQL pool error:", err);
  });

  pool.on("connection", (conn) => {
    console.log("MySQL pool: new connection opened.");

    conn.query("SET time_zone = '+08:00'", (err) => {
      if (err) {
        console.error("Failed to set MySQL timezone:", err);
      }
    });
  })

  pool.on("error", (err) => {
    console.error("MySQL pool error:", err);
  });

  pool.on("connection", () => {
    console.log("MySQL pool: new connection opened.");
  });

  // Retry a SELECT once if it failed because the pooled connection was dead.
  const rawQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    try {
      return await rawQuery(...args);
    } catch (err) {
      if (!DEAD_CONNECTION_CODES.has(err.code) || !isSelectQuery(args[0])) throw err;
      console.warn(`MySQL ${err.code} on a SELECT, retrying once on a fresh connection...`);
      return rawQuery(...args);
    }
  };

  return pool;
}

if (!global.__mysqlPool) {
  global.__mysqlPool = createPool();
}

const connection = global.__mysqlPool;
async function cleanupStaleConnections() {
  try {
    const [rows] = await connection.query(
      `SELECT id, time
       FROM information_schema.processlist
       WHERE user = ?
         AND command = 'Sleep'
         AND time > ?`,
      [process.env.DB_USER, STALE_CONNECTION_SECONDS]
    );

    if (rows.length === 0) return;

    console.log(
      `Found ${rows.length} stale MySQL connection(s) for this user, cleaning up...`
    );

    for (const row of rows) {
      try {
        await connection.query("KILL ?", [row.id]);
        console.log(`Killed stale connection id=${row.id} (idle ${row.time}s)`);
      } catch (killErr) {
        console.warn(`Could not kill connection id=${row.id}:`, killErr.message);
      }
    }
  } catch (err) {
    console.warn("Stale connection cleanup skipped:", err.message);
  }
}

if (!global.__mysqlPoolCleaned) {
  global.__mysqlPoolCleaned = true;
  cleanupStaleConnections();
}

let isClosing = false;

async function closePool(signal) {
  if (isClosing) return; // avoid double-handling if multiple signals fire
  isClosing = true;

  console.log(`Received ${signal}, closing MySQL pool...`);

  try {
    // Safety timeout in case pool.end() hangs on a stuck connection.
    await Promise.race([
      connection.end(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    console.log("MySQL pool closed.");
  } catch (err) {
    console.error("Error closing MySQL pool:", err);
  }

  delete global.__mysqlPool;
  delete global.__mysqlPoolCleaned;

  if (signal === "SIGUSR2") {
    // Hand control back to nodemon so it can proceed with the restart
    // instead of us force-exiting mid-handshake.
    process.kill(process.pid, "SIGUSR2");
  } else {
    process.exit(0);
  }
}

if (!global.__mysqlShutdownHooksAttached) {
  global.__mysqlShutdownHooksAttached = true;
  process.on("SIGINT", () => closePool("SIGINT")); // Ctrl+C
  process.on("SIGTERM", () => closePool("SIGTERM")); // normal kill
  process.on("SIGUSR2", () => closePool("SIGUSR2")); // nodemon restart signal
}

module.exports = connection;