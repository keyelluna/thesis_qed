// // const mysql = require("mysql2");

// // const connection = mysql
// //   .createPool({
// //     host: process.env.DB_HOST,
// //     user: process.env.DB_USER,
// //     password: process.env.DB_PASSWORD,
// //     database: process.env.DB_NAME,
// //     dateStrings: true,
// //     waitForConnections: true,
// //     connectionLimit: 4, 
// //     queueLimit: 0,
// //   })
// //   .promise();

// // module.exports = connection;

// const mysql = require("mysql2");

// // Check if a global connection pool already exists
// // if (!global.dbConnectionPool) {
// //   global.dbConnectionPool = mysql
// //     .createPool({
// //       host: process.env.DB_HOST,
// //       user: process.env.DB_USER,
// //       password: process.env.DB_PASSWORD,
// //       database: process.env.DB_NAME,
// //       dateStrings: true,
// //       waitForConnections: true,
// //       connectionLimit: 2, // 🔑 Dropped to 2 to leave breathing room for restarts
// //       queueLimit: 0,
// //     })
// //     .promise();
// // }

// // module.exports = global.dbConnectionPool;
// const connection = mysql
//   .createPool({
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME,
//     dateStrings: true,
//     waitForConnections: true,
//     connectionLimit: 5, 
//     queueLimit: 0,
//     // enableKeepAlive: true, // <--- Add this to keep connections alive
//     // keepAliveInitialDelay: 10000 // <--- 10 seconds
//   })
//   .promise();

// // Gracefully close the pool so connections don't leak when the process
// // restarts (e.g. nodemon) or is killed.
// async function closePool(signal) {
//   console.log(`Received ${signal}, closing MySQL pool...`);
//   try {
//     await connection.end();
//     console.log("MySQL pool closed.");
//   } catch (err) {
//     console.error("Error closing MySQL pool:", err);
//   } finally {
//     process.exit(0);
//   }
// }

// process.on("SIGINT", () => closePool("SIGINT"));   // Ctrl+C
// process.on("SIGTERM", () => closePool("SIGTERM")); // normal kill
// process.on("SIGUSR2", () => closePool("SIGUSR2")); // nodemon restart signal

// module.exports = connection;

const mysql = require("mysql2");

// -----------------------------------------------------------------------
// IMPORTANT: connectionLimit must stay comfortably BELOW your MySQL user's
// 'max_user_connections' limit (currently 5 on the server side).
// Setting this equal to the server cap leaves zero headroom, so any
// leftover connection (a previous crashed process, a Workbench/CLI
// session, an overlapping nodemon restart, etc.) immediately pushes you
// over the limit and every query starts failing with ER_USER_LIMIT_REACHED.
// -----------------------------------------------------------------------
const connection = mysql
  .createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 3, // kept below the server's max_user_connections (5) on purpose
    queueLimit: 0,
  })
  .promise();

// Gracefully close the pool so connections don't leak when the process
// restarts (e.g. nodemon) or is killed.
//
// Notes on why this differs from before:
// - pool.end() waits for in-use connections to finish before resolving,
//   so we always await it (with a safety timeout) rather than assuming
//   it resolves instantly.
// - For SIGUSR2 (the signal nodemon sends on file-change restarts), we
//   must re-send SIGUSR2 to our own process afterward instead of calling
//   process.exit() directly. Calling process.exit() there short-circuits
//   nodemon's restart handshake and can cause the old and new process to
//   briefly overlap, doubling up on connections against the DB's limit.
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

  if (signal === "SIGUSR2") {
    // Hand control back to nodemon so it can proceed with the restart
    // instead of us force-exiting mid-handshake.
    process.kill(process.pid, "SIGUSR2");
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => closePool("SIGINT"));   // Ctrl+C
process.on("SIGTERM", () => closePool("SIGTERM")); // normal kill
process.on("SIGUSR2", () => closePool("SIGUSR2")); // nodemon restart signal

module.exports = connection;
