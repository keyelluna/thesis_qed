const jwt = require('jsonwebtoken');
const { validSessionClaims } = require('../../authentication/sessionClaims');

function actorFromRequest(req) {
  if (validSessionClaims(req.user)) return req.user;
  const token = req.cookies?.token;
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!validSessionClaims(decoded)) return null;
    return { userId: decoded.userId, userName: decoded.userName ?? null, role: decoded.role };
  } catch { return null; }
}

module.exports = { actorFromRequest };
