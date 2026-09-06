//ENVIRONMENT VARIABLES
require('dotenv').config();

//API FRAMEWORD
const express = require('express');
//CROSS ORIGIN RESOURCE SHARING
const cors = require('cors');
//DATABASE CONNECTION
const db=require('./config/db.js');
//ROUTES
const apiRoutes = require('./src/routes/index.js');

//UTILIZATION OF EXPRESS
const app = express();

const cookieParser = require('cookie-parser');

//MOMENT
const moment = require('moment');
const logger = (req, res, next) => {
    console.log(`${req.protocol}://${req.get('host')} ${req.originalUrl} - ${moment().format()}` );
    next();
}
app.use(logger);

app.use(cookieParser());

const corsOptions = {
  origin: ['http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // kung gumagamit ka ng cookies/session
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({extended:true})) //this will allow to read the url body tags

//use routes
app.use('/api', apiRoutes);

// Catch-all for unmatched routes — guarantees the frontend NEVER receives
// HTML where it expects JSON, no matter which route is missing/misspelled.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `No matching route: ${req.method} ${req.originalUrl}`,
  });
});

// Centralized error handler — catches anything thrown/rejected in your
// route handlers that isn't already caught locally.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error.",
  });
});

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
})