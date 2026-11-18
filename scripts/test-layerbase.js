
require("dotenv").config({
  path: require("node:path").join(__dirname, "../.env"),
  quiet: true,
});

const mysql = require("mysql2/promise");

async function testConnection() {
  let connection;

  const start = Date.now();

  try {
    console.log("Connecting to Layerbase...");
    console.log("Host:", process.env.DB_HOST);
    console.log("Port:", process.env.DB_PORT);

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,

      ssl: {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },

      connectTimeout: 60000,
    });

    console.log("Connected successfully!");
    console.log("Connection time:", Date.now() - start, "ms");

    const [rows] = await connection.query(
      "SELECT DATABASE() AS db, VERSION() AS version"
    );

    console.log("Database:", rows[0].db);
    console.log("Version:", rows[0].version);

    const [tlsRows] = await connection.query(
      "SHOW SESSION STATUS LIKE 'Ssl_cipher'"
    );

    console.log("TLS cipher:", tlsRows[0]?.Value || "Not confirmed");

  } catch (error) {
    console.error("Connection failed!");
    console.error("Error code:", error.code);
    console.error("Message:", error.message);
    console.error("Elapsed:", Date.now() - start, "ms");
    process.exitCode = 1;

  } finally {
    if (connection) await connection.end();
  }
}

testConnection();
