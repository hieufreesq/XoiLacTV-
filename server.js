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

// ─── Cấu hình Metered TURN ────────────────────────────────────────────────
const METERED_API_KEY  = process.env.METERED_API_KEY  || "Jy_TP2M-dA5pqY6TjA9EDYWagtgaPtOq_o8gDo1a73sHEb8m";
const METERED_APP_NAME = process.env.METERED_APP_NAME || "xoilactv.metered.live";

// ─── Route: cấp ICE Servers (STUN + TURN credentials) cho client ──────────
// Client gọi GET /api/ice-servers trước khi tạo RTCPeerConnection
app.get("/api/ice-servers", async (req, res) => {
  try {
    const url = `https://${METERED_APP_NAME}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Metered API lỗi: ${response.status}`);
    }

    const iceServers = await response.json();

    // Thêm STUN của Google vào đầu danh sách
    const fullIceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      ...iceServers,
    ];

    console.log(`[SERVER] Cấp ICE Servers: ${fullIceServers.length} servers`);
    res.json(fullIceServers);
  } catch (err) {
    console.error("[SERVER] Lỗi lấy ICE Servers từ Metered:", err.message);

    // Fallback: chỉ trả về STUN nếu TURN lỗi
    res.json([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ]);
  }
});

// ─── Lưu trữ danh sách phòng và người dùng ────────────────────────────────
// rooms = { roomId: { users: [{ socketId, username, joinedAt }] } }
const rooms = {};

// ─── Xử lý kết nối Socket.IO ──────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[SERVER] Người dùng kết nối: ${socket.id}`);

  /**
   * SỰ KIỆN: join-room
   * Client gửi khi muốn tham gia phòng họp
   * Payload: { roomId, username }
   */
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

    console.log(
      `[SERVER] ${username} tham gia phòng ${roomId} | Tổng: ${room.users.length} người`
    );
  });

  /**
   * SỰ KIỆN: offer
   */
  socket.on("offer", ({ targetId, offer }) => {
    console.log(`[SERVER] SDP Offer: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("offer", {
      offer,
      fromId: socket.id,
      username: socket.username,
    });
  });

  /**
   * SỰ KIỆN: answer
   */
  socket.on("answer", ({ targetId, answer }) => {
    console.log(`[SERVER] SDP Answer: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("answer", { answer, fromId: socket.id });
  });

  /**
   * SỰ KIỆN: ice-candidate
   */
  socket.on("ice-candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("ice-candidate", { candidate, fromId: socket.id });
  });

  /**
   * SỰ KIỆN: latency-ping
   */
  socket.on("latency-ping", ({ timestamp, targetId }) => {
    if (targetId) {
      io.to(targetId).emit("latency-ping", {
        timestamp,
        fromId: socket.id,
      });
    }
  });

  socket.on("latency-pong", ({ timestamp, targetId }) => {
    io.to(targetId).emit("latency-pong", { timestamp, fromId: socket.id });
  });

  /**
   * SỰ KIỆN: chat-message
   */
  socket.on("chat-message", ({ roomId, message, username }) => {
    io.to(roomId).emit("chat-message", {
      message,
      username,
      socketId: socket.id,
      timestamp: Date.now(),
    });
  });

  /**
   * SỰ KIỆN: disconnect
   */
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
║   WebRTC P2P + Socket.IO + TURN       ║
╚═══════════════════════════════════════╝
  `);
});
