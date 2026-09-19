const mysql = require("mysql2");

const STALE_CONNECTION_SECONDS = 60; 
const POOL_CONNECTION_LIMIT = 2; 

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