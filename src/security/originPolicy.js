const PRODUCTION_ORIGIN = 'https://qed-front-end-6upk.vercel.app';
const DEVELOPMENT_ORIGIN = 'http://localhost:5173';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function approvedOrigins(environment = process.env.NODE_ENV) {
  return environment === 'development'
    ? [PRODUCTION_ORIGIN, DEVELOPMENT_ORIGIN]
    : [PRODUCTION_ORIGIN];
}

function exactOrigin(value, environment) {
  if (typeof value !== 'string' || value === 'null') return false;
  try {
    const url = new URL(value);
    return url.origin === value && approvedOrigins(environment).includes(value);
  } catch { return false; }
}

function httpOriginAllowed(headers, environment = process.env.NODE_ENV) {
  // A supplied Origin is authoritative: never rescue a bad Origin with Referer.
  if (headers.origin !== undefined) return exactOrigin(headers.origin, environment);
  if (typeof headers.referer !== 'string') return false;
  try {
    const url = new URL(headers.referer);
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return false;
    return exactOrigin(url.origin, environment);
  } catch { return false; }
}

function socketOriginAllowed(headers, environment = process.env.NODE_ENV) {
  // Browsers supply Origin on cross-origin polling/WebSocket handshakes.
  // No non-browser clients are currently approved; absence fails closed.
  return exactOrigin(headers.origin, environment);
}

function requireMutationOrigin(req, res, next) {
  // Existing authenticated GET handlers can lazily create quizzes/template pins
  // or refresh metadata. Cover cookie-bearing reads without changing those APIs.
  const authenticatedRead = ['GET', 'HEAD'].includes(req.method) && Boolean(req.headers.cookie);
  if ((!MUTATION_METHODS.has(req.method) && !authenticatedRead) || httpOriginAllowed(req.headers)) return next();
  return res.status(403).json({ success: false, message: 'Request origin is not allowed.' });
}

module.exports = { approvedOrigins, httpOriginAllowed, socketOriginAllowed, requireMutationOrigin };
