const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const context = new AsyncLocalStorage();
const knownCodes = new Set(['DB_ACQUIRE_TIMEOUT','DB_HEALTH_TIMEOUT','DB_TLS_CONFIG','HANDSHAKE_SSL_ERROR','HANDSHAKE_NO_SSL_SUPPORT','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','PROTOCOL_CONNECTION_LOST','ER_CON_COUNT_ERROR','POOL_CLOSED']);
function failureCode(error) { return knownCodes.has(error?.code) ? error.code : 'INTERNAL_ERROR'; }
function diagnostic(event, error, log = console.warn) {
  log(JSON.stringify({ event, requestId: context.getStore()?.requestId, code: failureCode(error) }));
}
function requestDiagnostics({ log = console.log, id = randomUUID, now = () => performance.now() } = {}) {
  return (req, res, next) => {
    const requestId = id();
    const started = now();
    res.setHeader('X-Request-ID', requestId);
    context.run({ requestId }, () => {
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        log(JSON.stringify({ event: 'http_request', requestId,
          method: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(req.method) ? req.method : 'OTHER',
          route: typeof req.route?.path === 'string' ? req.route.path : 'unmatched',
          status: res.statusCode, durationMs: Math.max(0, Math.round(now() - started)), completed: res.writableFinished === true }));
      };
      res.once('finish', record);
      res.once('close', record);
      next();
    });
  };
}
function notFound(req, res) { res.status(404).json({ success: false, message: 'No matching route.' }); }
function operationalError(error, req, res, next) {
  diagnostic('http_error', error);
  if (res.headersSent) { res.destroy(); return; }
  const unavailable = knownCodes.has(error?.code);
  const status = unavailable ? 503 : Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  const messages = {400:'Invalid request.',401:'Authentication required.',403:'Access denied.',404:'Not found.',413:'Request is too large.',429:'Too many requests.'};
  res.status(status).json({ success: false, code: unavailable ? 'SERVICE_UNAVAILABLE' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED',
    message: unavailable ? 'Service temporarily unavailable. Please retry.' : messages[status] || (status >= 500 ? 'Internal server error.' : 'Request rejected.') });
}
module.exports = { requestDiagnostics, operationalError, notFound, diagnostic, failureCode };
