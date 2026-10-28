const dns = require('node:dns').promises;
const net = require('node:net');

// One connection per Render startup. No credentials, queries, or public endpoint.
// A TCP connection alone is insufficient: wait for MySQL's initial handshake.
async function probeDatabaseNetwork({ host, port = 3306, timeoutMs = 10000, log = console.log }) {
  const started = Date.now();
  let socket, timer, address, finished = false, stage = 'dns';
  const report = (result, code) => log(JSON.stringify({
    event: 'db_network_probe', timestamp: new Date().toISOString(),
    host, port, address, family: 'IPv4', stage, result, code,
    durationMs: Date.now() - started,
    // This is the container's address, not necessarily Render's public NAT IP.
    localAddress: socket?.localAddress,
  }));
  try {
    if (!host) { report('failed', 'DB_HOST_MISSING'); return; }
    await Promise.race([
      (async () => {
        ({ address } = await dns.lookup(host, { family: 4 }));
        if (finished) return;
        stage = 'tcp';
        await new Promise((resolve, reject) => {
          socket = net.createConnection({ host: address, port, family: 4, autoSelectFamily: false });
          let greeting = Buffer.alloc(0);
          socket.once('error', reject);
          socket.once('connect', () => { stage = 'mysql_greeting'; });
          socket.once('end', () => reject(Object.assign(new Error(), { code: 'PEER_CLOSED' })));
          socket.on('data', chunk => {
            greeting = Buffer.concat([greeting, chunk.subarray(0, 5 - greeting.length)]);
            if (greeting.length < 5) return;
            if (greeting[3] === 0 && greeting[4] === 10) resolve();
            else reject(Object.assign(new Error(), { code: 'UNEXPECTED_GREETING' }));
          });
        });
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'PROBE_TIMEOUT' })), timeoutMs);
      }),
    ]);
    report('connected');
  } catch (error) {
    const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'PROBE_TIMEOUT', 'PEER_CLOSED', 'UNEXPECTED_GREETING']);
    report('failed', allowed.has(error.code) ? error.code : 'NETWORK_ERROR');
  } finally {
    finished = true;
    clearTimeout(timer);
    socket?.destroy();
  }
}

module.exports = { probeDatabaseNetwork };
