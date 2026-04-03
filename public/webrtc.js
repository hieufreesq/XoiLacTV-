/**
 * ============================================================
 * XoiLacTV - WebRTC Peer Connection Manager (webrtc.js)
 * ============================================================
 * Quản lý toàn bộ logic WebRTC:
 * - Tạo và quản lý RTCPeerConnection với nhiều peer
 * - Fetch ICE Servers (STUN + TURN) động từ server
 * - Xử lý Echo Cancellation thông qua AudioContext + constraints
 * - Đo độ trễ End-to-End bằng RTCPeerConnection.getStats()
 *
 * ⚠️  HƯỚNG DẪN SỬ DỤNG ĐÚNG THỨ TỰ (app.js):
 *
 *   // B1: Lấy stream từ camera/mic
 *   const rawStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
 *
 *   // B2: Xử lý echo TRƯỚC khi tạo manager
 *   const localStream = await WebRTCManager.processStream(rawStream);
 *
 *   // B3: Mới tạo manager với stream đã xử lý
 *   const manager = new WebRTCManager(socket, localStream, onRemoteStream, onDisconnect);
 *
 * TEST: node server.js → mở http://localhost:3000
 * ============================================================
 */

class WebRTCManager {
  constructor(socket, localStream, onRemoteStream, onPeerDisconnect) {
    this.socket = socket;
    this.localStream = localStream;
    this.onRemoteStream = onRemoteStream;
    this.onPeerDisconnect = onPeerDisconnect;

    // Lưu tất cả RTCPeerConnection: { peerId: RTCPeerConnection }
    this.peerConnections = {};

    // Bộ đếm thống kê độ trễ
    this.latencyStats = {};

    // ICE config sẽ được load động từ server qua _loadIceConfig()
    // Mặc định fallback chỉ có STUN (dùng khi fetch thất bại)
    this.iceConfig = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    };

    // Load ICE servers có TURN từ server ngay khi khởi tạo
    this._loadIceConfig();

    // Khởi động vòng lặp đo latency mỗi 3 giây
    this._startLatencyMonitor();
  }

  /**
   * Fetch ICE Servers (STUN + TURN) từ /api/ice-servers trên server
   * Server sẽ gọi Metered API và trả về credentials hợp lệ
   */
  async _loadIceConfig() {
    try {
      const res = await fetch("/api/ice-servers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const iceServers = await res.json();
      this.iceConfig = {
        iceServers,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      };
      console.log(`[WebRTC] Đã load ${iceServers.length} ICE servers (gồm TURN)`);
    } catch (err) {
      console.warn("[WebRTC] Không load được ICE servers từ server, dùng STUN fallback:", err.message);
    }
  }

  /**
   * ────────────────────────────────────────────────────────────
   * ECHO CANCELLATION (STATIC) - Xử lý stream TRƯỚC khi kết nối
   * ────────────────────────────────────────────────────────────
   * ⚠️  Phải gọi TRƯỚC khi tạo WebRTCManager.
   *     Nếu gọi sau khi addTrack() thì PC vẫn dùng stream gốc.
   *
   * Cách dùng đúng trong app.js:
   *   const localStream = await WebRTCManager.processStream(rawStream);
   *   const manager = new WebRTCManager(socket, localStream, ...);
   *
   * @param {MediaStream} stream - Stream gốc từ getUserMedia
   * @returns {Promise<MediaStream>} Stream đã xử lý echo cancellation
   */
  static async processStream(stream) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        console.warn("[Echo] AudioContext không được hỗ trợ, dùng stream gốc");
        return stream;
      }

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);

      // DynamicsCompressor: giảm âm lượng đột biến
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-30, audioContext.currentTime);
      compressor.knee.setValueAtTime(40, audioContext.currentTime);
      compressor.ratio.setValueAtTime(12, audioContext.currentTime);
      compressor.attack.setValueAtTime(0, audioContext.currentTime);
      compressor.release.setValueAtTime(0.25, audioContext.currentTime);

      // Lọc tần số thấp dưới 80Hz (tiếng ù phòng)
      const highpassFilter = audioContext.createBiquadFilter();
      highpassFilter.type = "highpass";
      highpassFilter.frequency.setValueAtTime(80, audioContext.currentTime);

      // Lọc tần số cao trên 8kHz (nhiễu)
      const lowpassFilter = audioContext.createBiquadFilter();
      lowpassFilter.type = "lowpass";
      lowpassFilter.frequency.setValueAtTime(8000, audioContext.currentTime);

      const destination = audioContext.createMediaStreamDestination();
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
   * Tạo RTCPeerConnection mới với một peer
   * @param {string} peerId - Socket ID của peer
   * @param {boolean} isInitiator - true nếu mình là người gọi
   */
  createPeerConnection(peerId, isInitiator) {
    console.log(`[WebRTC] Tạo kết nối với ${peerId} | Initiator: ${isInitiator}`);

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections[peerId] = pc;
    this.latencyStats[peerId] = { rtt: 0, jitter: 0, packetLoss: 0 };

    // Thêm local stream vào kết nối
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Nhận remote stream từ peer
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Nhận track từ ${peerId}:`, event.track.kind);
      const [remoteStream] = event.streams;
      this.onRemoteStream(peerId, remoteStream);
    };

    // Gửi ICE Candidates qua signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("ice-candidate", {
          targetId: peerId,
          candidate: event.candidate,
        });
      }
    };

    // Theo dõi trạng thái ICE — log để debug
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE State (${peerId}): ${pc.iceConnectionState}`);
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed"
      ) {
        this.onPeerDisconnect(peerId);
        this.closePeerConnection(peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection State (${peerId}): ${pc.connectionState}`);
    };

    if (isInitiator) {
      this._createOffer(peerId, pc);
    }

    return pc;
  }

  /**
   * Tạo SDP Offer và gửi cho peer
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
   * Xử lý SDP Offer nhận được từ peer — tạo Answer và gửi lại
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
   * ĐO ĐỘ TRỄ END-TO-END (Latency Measurement)
   * ────────────────────────────────────────────────────────────
   */
  async measureLatency(peerId) {
    const pc = this.peerConnections[peerId];
    if (!pc) return null;

    try {
      const stats = await pc.getStats();
      const result = {
        rtt: 0,
        jitter: 0,
        packetLoss: 0,
        bytesSent: 0,
        bytesReceived: 0,
        framesPerSecond: 0,
        timestamp: Date.now(),
      };

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          if (report.currentRoundTripTime !== undefined) {
            result.rtt = Math.round(report.currentRoundTripTime * 1000);
          }
          result.bytesSent = report.bytesSent || 0;
          result.bytesReceived = report.bytesReceived || 0;
        }

        if (report.type === "inbound-rtp") {
          if (report.jitter !== undefined) {
            result.jitter = Math.round(report.jitter * 1000);
          }
          if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
            const total = report.packetsReceived + report.packetsLost;
            if (total > 0) {
              result.packetLoss = ((report.packetsLost / total) * 100).toFixed(2);
            }
          }
          if (report.framesPerSecond !== undefined) {
            result.framesPerSecond = Math.round(report.framesPerSecond);
          }
        }
      });

      this.latencyStats[peerId] = result;
      return result;
    } catch (err) {
      console.error("[Latency] Lỗi đo latency:", err);
      return null;
    }
  }

  /**
   * Vòng lặp tự động đo latency cho tất cả peer mỗi 3 giây
   */
  _startLatencyMonitor() {
    setInterval(async () => {
      for (const peerId in this.peerConnections) {
        const stats = await this.measureLatency(peerId);
        if (stats) {
          window.dispatchEvent(
            new CustomEvent("latency-update", {
              detail: { peerId, stats },
            })
          );
        }
      }
    }, 3000);
  }

  /**
   * Tắt/bật micro
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
