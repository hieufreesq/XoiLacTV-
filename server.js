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
   * TEST: Mở 2 tab, cùng nhập 1 roomId → xem cả 2 có kết nối không
   */
  socket.on("join-room", ({ roomId, username }) => {
    // Tạo phòng nếu chưa tồn tại
    if (!rooms[roomId]) {
      rooms[roomId] = { users: [] };
    }

    const room = rooms[roomId];

    // Giới hạn tối đa 10 người/phòng
    if (room.users.length >= 10) {
      socket.emit("room-full", { message: "Phòng đã đầy (tối đa 10 người)" });
      return;
    }

    // Thêm user vào phòng
    room.users.push({
      socketId: socket.id,
      username: username || `Người dùng ${socket.id.slice(0, 4)}`,
      joinedAt: Date.now(),
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    // Thông báo cho user mới: danh sách người đang có trong phòng
    const existingUsers = room.users
      .filter((u) => u.socketId !== socket.id)
      .map((u) => ({ socketId: u.socketId, username: u.username }));

    socket.emit("room-joined", {
      roomId,
      existingUsers,
      mySocketId: socket.id,
    });

    // Thông báo cho mọi người trong phòng có user mới
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
   * Peer A gửi SDP Offer đến Peer B để bắt đầu thương lượng WebRTC
   * TEST: Xem console log khi 2 peer kết nối
   */
  socket.on("offer", ({ targetId, offer, fromId }) => {
    console.log(`[SERVER] SDP Offer: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("offer", {
      offer,
      fromId: socket.id,
      username: socket.username,
    });
  });

  /**
   * SỰ KIỆN: answer
   * Peer B trả lời SDP Answer cho Peer A
   */
  socket.on("answer", ({ targetId, answer }) => {
    console.log(`[SERVER] SDP Answer: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("answer", { answer, fromId: socket.id });
  });

  /**
   * SỰ KIỆN: ice-candidate
   * Trao đổi ICE Candidates để tìm đường kết nối P2P tốt nhất
   * TEST: Xem Network tab trong Chrome DevTools → WebRTC internals
   */
  socket.on("ice-candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("ice-candidate", { candidate, fromId: socket.id });
  });

  /**
   * SỰ KIỆN: latency-ping
   * Client gửi ping để đo độ trễ end-to-end qua signaling server
   * TEST: Xem kết quả latency hiển thị trên UI
   */
  socket.on("latency-ping", ({ timestamp, targetId }) => {
    // Chuyển tiếp ping đến peer đích (đo RTT thực tế)
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
   * Nhắn tin trong phòng
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
   * Xử lý khi người dùng ngắt kết nối
   */
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      // Xóa user khỏi danh sách phòng
      rooms[roomId].users = rooms[roomId].users.filter(
        (u) => u.socketId !== socket.id
      );

      // Thông báo cho mọi người trong phòng
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        username: socket.username,
      });

      // Dọn dẹp phòng trống
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
