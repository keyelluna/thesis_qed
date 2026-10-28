const https = require('node:https');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { probeDatabaseNetwork } = require('./databaseNetworkProbe');

function checkHttps(url, { readIp = false, timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let done = false, request, timer;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request?.destroy();
      resolve({ ...result, durationMs: Date.now() - started });
    };
    timer = setTimeout(() => finish({ result: 'failed', code: 'HTTPS_TIMEOUT' }), timeoutMs);
    request = https.get(url, { family: 4, agent: false }, response => {
      const common = { status: response.statusCode, address: response.socket.remoteAddress };
      // Any HTTP response proves HTTPS connectivity; do not log website content.
      if (!readIp) { finish({ result: 'connected', ...common }); return; }
      let body = '';
      response.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 128) finish({ result: 'failed', code: 'INVALID_IP_RESPONSE', ...common });
      });
      response.once('error', () => finish({ result: 'failed', code: 'HTTPS_RESPONSE_ERROR', ...common }));
      response.once('end', () => {
        const ip = body.trim();
        finish(response.statusCode === 200 && net.isIP(ip) === 4
          ? { result: 'connected', publicIp: ip, ...common }
          : { result: 'failed', code: 'INVALID_IP_RESPONSE', ...common });
      });
    });
    request.once('error', error => {
      const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
      finish({ result: 'failed', code: allowed.has(error.code) ? error.code : 'HTTPS_ERROR' });
    });
  });
}

// Temporary support evidence: sequential, spaced probes; never blocks HTTP startup.
async function runHostingNetworkDiagnostics({ host, port, log = console.log }, {
  httpsCheck = checkHttps, probe = probeDatabaseNetwork, pause = delay,
} = {}) {
  const emit = record => log(JSON.stringify({ timestamp: new Date().toISOString(), ...record }));
  await Promise.all([
    httpsCheck('https://api.ipify.org', { readIp: true }).then(result => emit({
      event: 'hosting_network_https', target: 'ipify',
      // Public source observed by ipify; MySQL traffic may use a different NAT IP.
      sourceIpScope: 'ipify_https_only', ...result,
    })),
    httpsCheck('https://cornflowerblue-sheep-255178.hostingersite.com').then(result => emit({
      event: 'hosting_network_https', target: 'hostinger_website', ...result,
    })),
  ]);
  let successes = 0;
  for (let attempt = 1; attempt <= 10; attempt++) {
    await probe({ host, port, log: line => {
      const record = JSON.parse(line);
      if (record.result === 'connected') successes++;
      emit({ ...record, attempt, totalAttempts: 10 });
    } });
    if (attempt < 10) await pause(2000);
  }
  emit({ event: 'hosting_network_summary', attempts: 10, successes, failures: 10 - successes });
}

module.exports = { checkHttps, runHostingNetworkDiagnostics };
