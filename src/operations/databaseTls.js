const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

const tlsCodes = new Set(['HANDSHAKE_SSL_ERROR', 'HANDSHAKE_NO_SSL_SUPPORT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

function configurationError() {
  return Object.assign(new Error('Database TLS configuration is invalid. Check DB_HOST, DB_TLS_MODE and DB_TLS_CA_FILE.'), { code: 'DB_TLS_CONFIG' });
}

function databaseTlsOptions(env = process.env, readFile = fs.readFileSync) {
  const required = env.NODE_ENV === 'production' || env.RENDER === 'true' || env.VERCEL === '1';
  const mode = env.DB_TLS_MODE || (required || env.DB_TLS_CA_FILE ? 'verify-full' : 'disabled');
  if (!['verify-full', 'disabled'].includes(mode) || (required && mode !== 'verify-full')) throw configurationError();
  if (mode === 'disabled') return undefined;
  // mysql2's identity check is explicit; require a DNS hostname, not an IP alias.
  const host = env.DB_HOST;
  if (typeof host !== 'string' || host.length > 253 || net.isIP(host) || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw configurationError();
  const options = { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' };
  if (env.DB_TLS_CA_FILE) {
    try {
      const ca = readFile(env.DB_TLS_CA_FILE, 'utf8');
      if (/PRIVATE KEY/.test(ca)) throw configurationError();
      const certificates = String(ca).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!certificates?.length || certificates.some(pem => !new X509Certificate(pem).ca)) throw configurationError();
      tls.createSecureContext({ ca, minVersion: options.minVersion });
      options.ca = ca;
    } catch { throw configurationError(); }
  }
  return options;
}

function sanitizedDatabaseTlsError(error) {
  if (!tlsCodes.has(error?.code)) return null;
  return Object.assign(new Error('Database TLS verification failed. Check the trusted CA and database hostname.'), { code: error.code, fatal: true });
}

module.exports = { databaseTlsOptions, sanitizedDatabaseTlsError };
