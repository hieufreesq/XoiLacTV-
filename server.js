/**
 * ============================================================
 * XoiLacTV - Signaling Server (server.js)
 * ============================================================
 * Chức năng: Máy chủ báo hiệu (signaling) cho WebRTC
 * Sử dụng Express + Socket.IO để trao đổi SDP và ICE Candidates
 * giữa các peer TRƯỚC khi kết nối P2P được thiết lập.
 *
 * TEST: node server.js → mở http://localhost:3000
 * ============================================================
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);

// ─── Socket.IO khởi tạo với CORS mở để test local ─────────────────────────
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ─── Phục vụ các file tĩnh từ thư mục public ──────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── API trả về ICE Servers (STUN + TURN) cho client ─────────────────────
// Gọi Metered.ca API để lấy TURN credentials động
// TEST: Mở https://xoilactv-n5.up.railway.app/api/ice-servers
//       Phải thấy JSON có mảng "iceServers" với các entry "turn:..."
app.get("/api/ice-servers", async (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:standard.relay.metered.live:80" },
  ];

  try {
    const meteredUrl = `https://xoilactv.metered.live/api/v1/turn/credentials?apiKey=Jy_TP2M-dA5pqY6TjA9EDYWagtgaPtOq_o8gDo1a73sHEb8m`;
    const response = await fetch(meteredUrl);
    const turns = await response.json();

    if (Array.isArray(turns) && turns.length > 0) {
      iceServers.push(...turns);
      console.log(`[ICE] ✅ Metered OK: ${turns.length} TURN servers`);
    } else {
      console.warn("[ICE] ⚠️ Metered trả về rỗng hoặc lỗi:", JSON.stringify(turns));
    }
  } catch (e) {
    console.error("[ICE] ❌ Metered fetch lỗi:", e.message);
  }

  const turnCount = iceServers.filter(s => String(s.urls).startsWith("turn")).length;
  console.log(`[ICE] Trả về client: ${iceServers.length} servers (${turnCount} TURN)`);
  res.json({ iceServers });
});

// ─── Lưu trữ danh sách phòng và người dùng ────────────────────────────────
const rooms = {};

// ─── Xử lý kết nối Socket.IO ──────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[SERVER] Người dùng kết nối: ${socket.id}`);

  // SỰ KIỆN: join-room
  socket.on("join-room", ({ roomId, username }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { users: [] };
    }

    const room = rooms[roomId];

    if (room.users.length >= 10) {
      socket.emit("room-full", { message: "Phòng đã đầy (tối đa 10 người)" });
      return;
    }

    room.users.push({
      socketId: socket.id,
      username: username || `Người dùng ${socket.id.slice(0, 4)}`,
      joinedAt: Date.now(),
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    const existingUsers = room.users
      .filter((u) => u.socketId !== socket.id)
      .map((u) => ({ socketId: u.socketId, username: u.username }));

    socket.emit("room-joined", {
      roomId,
      existingUsers,
      mySocketId: socket.id,
    });

    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      username: username || socket.id,
    });

    console.log(`[SERVER] ${username} tham gia phòng ${roomId} | Tổng: ${room.users.length} người`);
  });

  // SỰ KIỆN: offer - Peer A gửi SDP Offer đến Peer B
  socket.on("offer", ({ targetId, offer }) => {
    console.log(`[SERVER] SDP Offer: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("offer", {
      offer,
      fromId: socket.id,
      username: socket.username,
    });
  });

  // SỰ KIỆN: answer - Peer B trả lời SDP Answer
  socket.on("answer", ({ targetId, answer }) => {
    console.log(`[SERVER] SDP Answer: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("answer", { answer, fromId: socket.id });
  });

  // SỰ KIỆN: ice-candidate - Trao đổi ICE Candidates
  socket.on("ice-candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("ice-candidate", { candidate, fromId: socket.id });
  });

  // SỰ KIỆN: latency-ping - Đo độ trễ
  socket.on("latency-ping", ({ timestamp, targetId }) => {
    if (targetId) {
      io.to(targetId).emit("latency-ping", { timestamp, fromId: socket.id });
    }
  });

  socket.on("latency-pong", ({ timestamp, targetId }) => {
    io.to(targetId).emit("latency-pong", { timestamp, fromId: socket.id });
  });

  // SỰ KIỆN: chat-message
  socket.on("chat-message", ({ roomId, message, username }) => {
    io.to(roomId).emit("chat-message", {
      message,
      username,
      socketId: socket.id,
      timestamp: Date.now(),
    });
  });

  // SỰ KIỆN: disconnect
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(
        (u) => u.socketId !== socket.id
      );
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        username: socket.username,
      });
      if (rooms[roomId].users.length === 0) {
        delete rooms[roomId];
        console.log(`[SERVER] Phòng ${roomId} đã bị xóa (trống)`);
      }
    }
    console.log(`[SERVER] Người dùng ngắt kết nối: ${socket.id}`);
  });
});

// ─── Khởi động server ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   XoiLacTV Signaling Server           ║
║   Đang chạy tại: http://localhost:${PORT}  ║
║   WebRTC P2P + Socket.IO              ║
╚═══════════════════════════════════════╝
  `);
});
