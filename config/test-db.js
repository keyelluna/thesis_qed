
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const mysql = require("mysql2/promise");

async function testDatabase() {
  let connection;

  try {
    console.log("Connecting to Hostinger MySQL...");

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 10000,
    });

    console.log("✅ Connected to Hostinger MySQL!");

    // Check database information
    const [rows] = await connection.query(
      "SELECT DATABASE() AS databaseName, VERSION() AS version"
    );

    console.log("Database:", rows[0].databaseName);
    console.log("MySQL version:", rows[0].version);

    const [tables] = await connection.query("SHOW TABLES");

    console.log("\nTotal tables:", tables.length);

    console.log("\nImported Tables:");
    tables.forEach((table, index) => {
      console.log(
        `${index + 1}. ${Object.values(table)[0]}`
      );
    });

  } catch (error) {
    console.error("❌ Database test failed!");
    console.error("Error code:", error.code);
    console.error("Message:", error.message);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

testDatabase();


// run (node config/test-db.js) to terminal to know if the hostinger is connected