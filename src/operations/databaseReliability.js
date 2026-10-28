const { diagnostic } = require('./requestDiagnostics');
const net = require('node:net');

// The database is reachable over IPv4; Render's IPv6 route is unavailable.
// Avoid Node's short dual-stack attempt timeout. mysql2 still owns its 10s
// connection deadline and upgrades this socket using the original TLS hostname.
function ipv4DatabaseStream({ config }, connect = net.createConnection) {
  const socket = connect({ host: config.host, port: config.port, family: 4, autoSelectFamily: false });
  socket.setNoDelay(true);
  if (config.enableKeepAlive) socket.once('connect', () => socket.setKeepAlive(true, config.keepAliveInitialDelay));
  return socket;
}

// Only acquisition is bounded here. Never race a running transaction or replay a write.
function boundPoolAcquisition(pool, { timeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout, report = diagnostic } = {}) {
  const acquire = pool.getConnection.bind(pool);
  pool.getConnection = callback => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      const error = Object.assign(new Error('Database connection temporarily unavailable.'), { code: 'DB_ACQUIRE_TIMEOUT' });
      report('db_acquisition_timeout', error);
      callback(error);
    }, timeoutMs);
    const done = (error, connection) => {
      if (settled) {
        if (connection) { try { connection.release(); } catch { connection.destroy(); } }
        return;
      }
      settled = true;
      clearTimer(timer);
      callback(error, connection);
    };
    try { acquire(done); } catch (error) { if (settled) throw error; done(error); }
  };
  return pool;
}
function databaseHealth(pool, { timeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout, report = diagnostic } = {}) {
  return async (req, res) => {
    let owned, finished = false;
    let timer;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      if (error) report('db_health_failed', error);
      res.status(error ? 503 : 200).json(error ? { status:'unhealthy', database:'unavailable' } : { status:'healthy', database:'connected' });
    };
    timer = setTimer(() => {
      if (finished) return;
      if (owned) { try { owned.destroy(); } catch {} owned = undefined; }
      finish(Object.assign(new Error('Database health deadline exceeded.'), { code:'DB_HEALTH_TIMEOUT' }));
    }, timeoutMs);
    try {
      const connection = await pool.getConnection();
      if (finished) { connection.release(); return; }
      owned = connection;
      await connection.query('SELECT 1');
      if (!finished) { owned = undefined; connection.release(); finish(); }
    } catch (error) {
      if (!finished) { if (owned) { try { owned.release(); } catch {} owned = undefined; } finish(error); }
    }
  };
}
module.exports = { boundPoolAcquisition, databaseHealth, ipv4DatabaseStream };
