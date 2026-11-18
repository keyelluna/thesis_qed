
require("dotenv").config({
  path: require("node:path").join(__dirname, "../.env"),
  quiet: true,
});

const pool = require("../config/db");

async function testPool() {
  try {
    console.log("Testing QED database pool...");

    const [rows] = await pool.query(
      "SELECT DATABASE() AS db, VERSION() AS version"
    );

    console.log("Connected successfully!");
    console.log("Database:", rows[0].db);
    console.log("Version:", rows[0].version);

    const [tls] = await pool.query(
      "SHOW SESSION STATUS LIKE 'Ssl_cipher'"
    );

    console.log("TLS cipher:", tls[0]?.Value || "Not confirmed");

  } catch (error) {
    console.error("Connection failed!");
    console.error("Error code:", error.code);
    console.error("Message:", error.message);
    process.exitCode = 1;

  } finally {
    await pool.end();
  }
}

testPool();
