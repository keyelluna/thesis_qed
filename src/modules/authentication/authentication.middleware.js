const jwt = require("jsonwebtoken");
const { validSessionClaims } = require('./sessionClaims');

module.exports = function verifyToken(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: 'No token provided.' });
  }

  // An unavailable verifier is not evidence that the browser's session is invalid.
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: 'Session verification is unavailable.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, decoded) => {
    if (err || !validSessionClaims(decoded)) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }
    req.user = decoded;
    next();
  });
};
