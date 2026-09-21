const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");

let io = null;

// user_id -> Set of socket.ids (isang user, pwede maraming tabs/devices)
const userSockets = new Map();

function initSocket(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Verify JWT galing sa httpOnly cookie bago payagan mag-connect
  io.use((socket, next) => {
    try {
      const rawCookie = socket.handshake.headers.cookie;
      if (!rawCookie) return next(new Error("No cookie provided"));

      const { token } = cookie.parse(rawCookie);
      if (!token) return next(new Error("No token provided"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;

      next();
    } catch (err) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.userId;
    console.log(`Socket connected: user ${userId} (${socket.id})`);

    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    socket.join(`user:${userId}`);

    socket.on("disconnect", () => {
      const set = userSockets.get(userId);
      set?.delete(socket.id);
      if (set && set.size === 0) userSockets.delete(userId);
      console.log(`Socket disconnected: user ${userId} (${socket.id})`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.io is not initialized");
  return io;
}

module.exports = { initSocket, getIO, userSockets };
