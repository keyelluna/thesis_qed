const connection = require('./config/db.js');

//ENVIRONMENT VARIABLES
require('dotenv').config();
// Optional private local storage settings; existing environment values take precedence.
require('dotenv').config({ path: require('node:path').join(__dirname, '.env.storage.local'), quiet: true });

const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { requestDiagnostics, operationalError, notFound } = require('./src/operations/requestDiagnostics');
const { databaseHealth } = require('./src/operations/databaseReliability');
if (process.env.RENDER === 'true') {
  void require('./src/operations/hostingNetworkDiagnostics').runHostingNetworkDiagnostics({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
  }).catch(() => console.warn(JSON.stringify({ event: 'hosting_network_diagnostics_failed' })));
}

const apiRoutes = require('./src/routes/index.js');
const { initSocket } = require('./socket.js');
const auditLog = require('./src/modules/shared/audit/auditLog.service.js');
const { approvedOrigins, requireMutationOrigin } = require('./src/security/originPolicy');

const app = express();

app.use(requestDiagnostics());

app.use(cookieParser());

const allowedOrigins = approvedOrigins();

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-ID'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use('/api', requireMutationOrigin);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', auditLog.auditMutationRequests);
app.use('/api', apiRoutes);

app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "healthy",
    service: "QED Backend",
  });
});

app.get("/health/database", databaseHealth(connection));

app.use(notFound);
app.use(operationalError);

//===== SOCKET.IO SETUP =====
// Vercel invokes this exported Express app. Importing it must not open a port
// or start background database writes during a build or a cold start.
module.exports = app;

if (process.env.VERCEL !== '1' && require.main === module) {
  const httpServer = createServer(app);
  initSocket(httpServer, allowedOrigins);

  Promise.all([auditLog.ensureAuditLogTable(), require("./src/modules/teacher/attendance/transferIn.service").ensureTransferInTable(), require("./src/modules/teacher/attendance/dropout.service").ensureDropoutTable()])
    .catch((error) => console.error('Application record tables could not be initialized:', error.message))
    .finally(() => {
      httpServer.listen(process.env.PORT || 7400, () => {
        console.log(`Server is running on port ${process.env.PORT || 7400}`);
      });
    });
}
