//ENVIRONMENT VARIABLES
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const moment = require('moment');

const apiRoutes = require('./src/routes/index.js');
const { initSocket } = require('./socket.js');

const app = express();

const logger = (req, res, next) => {
  console.log(`${req.protocol}://${req.get('host')} ${req.originalUrl} - ${moment().format()}`);
  next();
};
app.use(logger);

app.use(cookieParser());

const allowedOrigins = ['http://localhost:5173', 'https://qed-front-end-6upk.vercel.app'];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // ← dinagdag ang PATCH
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `No matching route: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.',
  });
});

//===== SOCKET.IO SETUP =====
const httpServer = createServer(app);
initSocket(httpServer, allowedOrigins);

httpServer.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});