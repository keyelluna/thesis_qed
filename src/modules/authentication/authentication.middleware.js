const jwt = require('jsonwebtoken');

module.exports = function verifyToken(req, res, next) {
  const token = req.cookies?.token; // galing sa httpOnly cookie

  if (!token) {
    return res.status(401).json({ message: 'No token provided.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token.' });
    }
    req.user = decoded;
    next();
  });
};