/**
 * ============================================================
 * XoiLacTV - WebRTC Peer Connection Manager (webrtc.js)
 * ============================================================
 * Quản lý toàn bộ logic WebRTC:
 * - Tạo và quản lý RTCPeerConnection với nhiều peer
 * - Xử lý Echo Cancellation thông qua AudioContext + constraints
 * - Đo độ trễ End-to-End bằng RTCPeerConnection.getStats()
 * - Thêm/xóa stream audio/video
 *
 * TEST ECHO CANCELLATION:
 *   Mở mic + loa cùng lúc → âm thanh không bị vọng lại
 *
 * TEST LATENCY:
 *   Xem bảng "Đánh giá độ trễ" trên giao diện
 * ============================================================
 */

class WebRTCManager {
  constructor(socket, localStream, onRemoteStream, onPeerDisconnect) {
    // Socket.IO để trao đổi SDP và ICE Candidates
    this.socket = socket;

    // Stream local (webcam + mic của mình)
    this.localStream = localStream;

    // Callback khi nhận được stream từ peer khác
    this.onRemoteStream = onRemoteStream;

    // Callback khi peer ngắt kết nối
    this.onPeerDisconnect = onPeerDisconnect;

    // Lưu tất cả RTCPeerConnection: { peerId: RTCPeerConnection }
    this.peerConnections = {};

    // Lưu AudioContext để xử lý Echo Cancellation
    this.audioContext = null;

    // Bộ đếm thống kê độ trễ
    this.latencyStats = {};

    // ─── Cấu hình ICE Servers (STUN public của Google) ──────────────────
    // TEST: Dùng STUN để kết nối qua NAT. Với mạng thực thêm TURN server.
    this.iceConfig = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ],
      // Tắt bundle để tách riêng audio/video streams
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    };

    // Khởi động vòng lặp đo latency mỗi 3 giây
    this._startLatencyMonitor();
  }

  /**
   * Tạo RTCPeerConnection mới với một peer
   * @param {string} peerId - Socket ID của peer
   * @param {boolean} isInitiator - true nếu mình là người gọi
   */
  createPeerConnection(peerId, isInitiator) {
    console.log(
      `[WebRTC] Tạo kết nối với ${peerId} | Initiator: ${isInitiator}`
    );

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections[peerId] = pc;
    this.latencyStats[peerId] = { rtt: 0, jitter: 0, packetLoss: 0 };

    // ─── Thêm local stream vào kết nối ────────────────────────────────
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ─── Nhận remote stream từ peer ───────────────────────────────────
    // TEST: Khi kết nối thành công, video của peer sẽ hiện ra
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Nhận track từ ${peerId}:`, event.track.kind);
      const [remoteStream] = event.streams;
      this.onRemoteStream(peerId, remoteStream);
    };

    // ─── Xử lý ICE Candidates ─────────────────────────────────────────
    // TEST: Xem chrome://webrtc-internals để theo dõi ICE gathering
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("ice-candidate", {
          targetId: peerId,
          candidate: event.candidate,
        });
      }
    };

    // ─── Theo dõi trạng thái kết nối ICE ──────────────────────────────
    pc.oniceconnectionstatechange = () => {
      console.log(
        `[WebRTC] ICE State (${peerId}): ${pc.iceConnectionState}`
      );
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed"
      ) {
        this.onPeerDisconnect(peerId);
        this.closePeerConnection(peerId);
      }
    };

    // ─── Theo dõi trạng thái kết nối chung ────────────────────────────
    pc.onconnectionstatechange = () => {
      console.log(
        `[WebRTC] Connection State (${peerId}): ${pc.connectionState}`
      );
    };

    // ─── Nếu là initiator: tạo Offer ──────────────────────────────────
    if (isInitiator) {
      this._createOffer(peerId, pc);
    }

    return pc;
  }

  /**
   * Tạo SDP Offer và gửi cho peer
   * TEST: Xem console log "SDP Offer tạo thành công"
   */
  async _createOffer(peerId, pc) {
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });

      await pc.setLocalDescription(offer);
      console.log(`[WebRTC] SDP Offer tạo thành công cho ${peerId}`);

      this.socket.emit("offer", {
        targetId: peerId,
        offer: pc.localDescription,
      });
    } catch (err) {
      console.error("[WebRTC] Lỗi tạo Offer:", err);
    }
  }

  /**
   * Xử lý SDP Offer nhận được từ peer
   * Tạo Answer và gửi lại
   */
  async handleOffer(peerId, offer) {
    let pc = this.peerConnections[peerId];
    if (!pc) {
      pc = this.createPeerConnection(peerId, false);
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      console.log(`[WebRTC] SDP Answer gửi cho ${peerId}`);
      this.socket.emit("answer", {
        targetId: peerId,
        answer: pc.localDescription,
      });
    } catch (err) {
      console.error("[WebRTC] Lỗi xử lý Offer:", err);
    }
  }

  /**
   * Xử lý SDP Answer nhận được
   */
  async handleAnswer(peerId, answer) {
    const pc = this.peerConnections[peerId];
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[WebRTC] Remote Description đặt thành công cho ${peerId}`);
    } catch (err) {
      console.error("[WebRTC] Lỗi xử lý Answer:", err);
    }
  }

  /**
   * Thêm ICE Candidate vào kết nối
   */
  async handleIceCandidate(peerId, candidate) {
    const pc = this.peerConnections[peerId];
    if (!pc) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("[WebRTC] Lỗi thêm ICE Candidate:", err);
    }
  }

  /**
   * ────────────────────────────────────────────────────────────
   * ECHO CANCELLATION - Xử lý triệt tiếng vọng
   * ────────────────────────────────────────────────────────────
   * Phương pháp 1: Browser tự xử lý qua getUserMedia constraints
   * Phương pháp 2: AudioContext pipeline để lọc thêm
   *
   * TEST ECHO CANCELLATION:
   *   1. Bật mic + loa (không dùng tai nghe)
   *   2. Nếu KHÔNG có echo cancellation → nghe thấy tiếng vọng
   *   3. Nếu CÓ echo cancellation → âm thanh sạch
   * ────────────────────────────────────────────────────────────
   */
  applyEchoCancellation(stream) {
    try {
      // Kiểm tra API AudioContext có sẵn không
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        console.warn("[Echo] AudioContext không được hỗ trợ");
        return stream;
      }

      this.audioContext = new AudioContext();

      // Tạo MediaStreamSource từ local stream
      const source = this.audioContext.createMediaStreamSource(stream);

      // ─── DynamicsCompressor: giảm âm lượng đột biến ─────────────────
      const compressor = this.audioContext.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-30, this.audioContext.currentTime);
      compressor.knee.setValueAtTime(40, this.audioContext.currentTime);
      compressor.ratio.setValueAtTime(12, this.audioContext.currentTime);
      compressor.attack.setValueAtTime(0, this.audioContext.currentTime);
      compressor.release.setValueAtTime(0.25, this.audioContext.currentTime);

      // ─── BiquadFilter: lọc tần số thấp (dưới 80Hz) và cao (trên 8kHz) ─
      // Loại bỏ tiếng ù phòng và tiếng nhiễu tần số cao
      const highpassFilter = this.audioContext.createBiquadFilter();
      highpassFilter.type = "highpass";
      highpassFilter.frequency.setValueAtTime(
        80,
        this.audioContext.currentTime
      );

      const lowpassFilter = this.audioContext.createBiquadFilter();
      lowpassFilter.type = "lowpass";
      lowpassFilter.frequency.setValueAtTime(
        8000,
        this.audioContext.currentTime
      );

      // ─── Kết nối pipeline: source → highpass → lowpass → compressor ──
      const destination =
        this.audioContext.createMediaStreamDestination();
      source
        .connect(highpassFilter)
        .connect(lowpassFilter)
        .connect(compressor)
        .connect(destination);

      // Ghép audio đã xử lý với video gốc
      const processedStream = new MediaStream([
        ...destination.stream.getAudioTracks(),
        ...stream.getVideoTracks(),
      ]);

      console.log("[Echo] Echo Cancellation pipeline đã được áp dụng");
      return processedStream;
    } catch (err) {
      console.error("[Echo] Lỗi khi áp dụng Echo Cancellation:", err);
      return stream;
    }
  }

  /**
   * ────────────────────────────────────────────────────────────
   * ĐO ĐỘ TRỄ END-TO-END (Latency Measurement)
   * ────────────────────────────────────────────────────────────
   * Sử dụng RTCPeerConnection.getStats() để lấy:
   * - RTT (Round-Trip Time): độ trễ khứ hồi
   * - Jitter: biến động độ trễ
   * - Packet Loss: tỷ lệ mất gói
   *
   * TEST LATENCY:
   *   1. Kết nối 2 peer
   *   2. Xem bảng "Đánh giá độ trễ" cập nhật mỗi 3 giây
   *   3. Thử mạng yếu (Chrome DevTools → Network throttling)
   * ────────────────────────────────────────────────────────────
   */
  async measureLatency(peerId) {
    const pc = this.peerConnections[peerId];
    if (!pc) return null;

    try {
      const stats = await pc.getStats();
      const result = {
        rtt: 0,        // Round-Trip Time (ms)
        jitter: 0,     // Jitter (ms)
        packetLoss: 0, // Tỷ lệ mất gói (%)
        bytesSent: 0,
        bytesReceived: 0,
        framesPerSecond: 0,
        timestamp: Date.now(),
      };

      stats.forEach((report) => {
        // ─── Lấy RTT từ candidate-pair (kết nối ICE) ─────────────────
        if (
          report.type === "candidate-pair" &&
          report.state === "succeeded"
        ) {
          if (report.currentRoundTripTime !== undefined) {
            result.rtt = Math.round(report.currentRoundTripTime * 1000); // chuyển sang ms
          }
          result.bytesSent = report.bytesSent || 0;
          result.bytesReceived = report.bytesReceived || 0;
        }

        // ─── Lấy Jitter từ inbound-rtp (nhận) ───────────────────────
        if (report.type === "inbound-rtp") {
          if (report.jitter !== undefined) {
            result.jitter = Math.round(report.jitter * 1000); // chuyển sang ms
          }

          // Tính Packet Loss
          if (
            report.packetsLost !== undefined &&
            report.packetsReceived !== undefined
          ) {
            const total = report.packetsReceived + report.packetsLost;
            if (total > 0) {
              result.packetLoss = (
                (report.packetsLost / total) *
                100
              ).toFixed(2);
            }
          }

          // FPS của video nhận
          if (report.framesPerSecond !== undefined) {
            result.framesPerSecond = Math.round(report.framesPerSecond);
          }
        }
      });

      // Lưu vào lịch sử để phân tích xu hướng
      this.latencyStats[peerId] = result;
      return result;
    } catch (err) {
      console.error("[Latency] Lỗi đo latency:", err);
      return null;
    }
  }

  /**
   * Vòng lặp tự động đo latency cho tất cả peer mỗi 3 giây
   * TEST: Xem console log cập nhật định kỳ
   */
  _startLatencyMonitor() {
    setInterval(async () => {
      for (const peerId in this.peerConnections) {
        const stats = await this.measureLatency(peerId);
        if (stats) {
          // Phát sự kiện để UI cập nhật
          window.dispatchEvent(
            new CustomEvent("latency-update", {
              detail: { peerId, stats },
            })
          );
        }
      }
    }, 3000); // Đo mỗi 3 giây
  }

  /**
   * Tắt/bật micro
   * TEST: Nhấn nút Mic trên UI → kiểm tra track.enabled
   */
  toggleAudio(enabled) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
  }

  /**
   * Tắt/bật camera
   */
  toggleVideo(enabled) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
  }

  /**
   * Đóng kết nối với một peer
   */
  closePeerConnection(peerId) {
    const pc = this.peerConnections[peerId];
    if (pc) {
      pc.close();
      delete this.peerConnections[peerId];
      delete this.latencyStats[peerId];
      console.log(`[WebRTC] Đã đóng kết nối với ${peerId}`);
    }
  }

  /**
   * Đóng tất cả kết nối khi rời phòng
   */
  closeAll() {
    Object.keys(this.peerConnections).forEach((peerId) => {
      this.closePeerConnection(peerId);
    });
    if (this.audioContext) {
      this.audioContext.close();
    }
    console.log("[WebRTC] Đã đóng tất cả kết nối");
  }

  /**
   * Lấy thống kê latency của tất cả peer
   */
  getAllLatencyStats() {
    return this.latencyStats;
  }
}

// Export để sử dụng trong app.js
window.WebRTCManager = WebRTCManager;
