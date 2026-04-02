/**
 * XoiLacTV - App Logic (app.js)
 * FIX: video grid chia đều, screen share layout, echo cancellation rõ hơn
 */

const AppState = {
  socket: null,
  webrtcManager: null,
  localStream: null,
  screenStream: null,
  roomId: null,
  username: null,
  isMicOn: true,
  isCameraOn: true,
  isEchoCancellation: true,
  isScreenSharing: false,
  peers: {},  // { peerId: { username, videoEl, container } }
};

// ── DOM ────────────────────────────────────────────────────────────────────
const screens = {
  lobby: document.getElementById('lobby-screen'),
  meeting: document.getElementById('meeting-screen'),
};

document.addEventListener('DOMContentLoaded', () => {
  initSocketConnection();
  initUIEvents();
  console.log('[App] XoiLacTV khởi động');
});

// ── Socket ─────────────────────────────────────────────────────────────────
function initSocketConnection() {
  AppState.socket = io(window.location.origin);

  AppState.socket.on('connect', () => {
    document.getElementById('connection-status').textContent = 'Đã kết nối';
    document.getElementById('connection-status').className = 'status-online';
    console.log('[Socket] Kết nối:', AppState.socket.id);
  });

  AppState.socket.on('disconnect', () => {
    document.getElementById('connection-status').textContent = 'Mất kết nối';
    document.getElementById('connection-status').className = 'status-offline';
  });

  AppState.socket.on('room-joined', ({ roomId, existingUsers, mySocketId }) => {
    console.log(`[Socket] Phòng ${roomId} | ${existingUsers.length} người`);
    existingUsers.forEach(({ socketId, username }) => {
      addPeerToRoom(socketId, username);
      AppState.webrtcManager.createPeerConnection(socketId, true);
    });
    switchToMeetingScreen(roomId);
  });

  AppState.socket.on('user-joined', ({ socketId, username }) => {
    addPeerToRoom(socketId, username);
    showNotification(`${username} đã tham gia`, 'join');
    AppState.webrtcManager.createPeerConnection(socketId, false);
  });

  AppState.socket.on('offer', ({ offer, fromId }) => {
    AppState.webrtcManager.handleOffer(fromId, offer);
  });

  AppState.socket.on('answer', ({ answer, fromId }) => {
    AppState.webrtcManager.handleAnswer(fromId, answer);
  });

  AppState.socket.on('ice-candidate', ({ candidate, fromId }) => {
    AppState.webrtcManager.handleIceCandidate(fromId, candidate);
  });

  AppState.socket.on('user-left', ({ socketId, username }) => {
    removePeerFromRoom(socketId);
    showNotification(`${username} đã rời phòng`, 'leave');
  });

  AppState.socket.on('room-full', ({ message }) => alert(message));

  AppState.socket.on('chat-message', ({ message, username, socketId, timestamp }) => {
    displayChatMessage(message, username, socketId === AppState.socket.id, timestamp);
  });
}

// ── UI Events ──────────────────────────────────────────────────────────────
function initUIEvents() {
  document.getElementById('btn-join').addEventListener('click', joinRoom);
  document.getElementById('input-room').addEventListener('keypress', e => {
    if (e.key === 'Enter') joinRoom();
  });
  document.getElementById('btn-toggle-mic').addEventListener('click', toggleMic);
  document.getElementById('btn-toggle-cam').addEventListener('click', toggleCamera);
  document.getElementById('btn-leave').addEventListener('click', leaveRoom);
  document.getElementById('btn-toggle-echo').addEventListener('click', toggleEchoCancellation);
  document.getElementById('btn-screen-share').addEventListener('click', toggleScreenShare);
  document.getElementById('btn-send-chat').addEventListener('click', sendChatMessage);
  document.getElementById('input-chat').addEventListener('keypress', e => {
    if (e.key === 'Enter') sendChatMessage();
  });

  window.addEventListener('latency-update', e => {
    updateLatencyUI(e.detail.peerId, e.detail.stats);
  });
}

// ── Join ───────────────────────────────────────────────────────────────────
async function joinRoom() {
  const roomInput = document.getElementById('input-room').value.trim();
  const usernameInput = document.getElementById('input-username').value.trim();

  if (!roomInput) { showLobbyError('Vui lòng nhập mã phòng!'); return; }

  AppState.roomId = roomInput;
  AppState.username = usernameInput || `Khách_${Math.random().toString(36).slice(2,6)}`;

  const btn = document.getElementById('btn-join');
  btn.textContent = 'Đang kết nối...'; btn.disabled = true;

  try {
    await initLocalStream();

    AppState.webrtcManager = new WebRTCManager(
      AppState.socket, AppState.localStream,
      handleRemoteStream, handlePeerDisconnect
    );

    AppState.socket.emit('join-room', {
      roomId: AppState.roomId, username: AppState.username
    });
  } catch (err) {
    console.error('[App] Lỗi:', err);
    showLobbyError('Không thể truy cập camera/mic. Vui lòng cấp quyền.');
    btn.textContent = 'Tham gia'; btn.disabled = false;
  }
}

// ── Local Stream với Echo Cancellation đầy đủ ──────────────────────────────
async function initLocalStream() {
  const audioConstraints = {
    // Level 1: Browser AEC — quan trọng nhất, xử lý ở tầng hardware/OS
    echoCancellation:  { ideal: true },
    noiseSuppression:  { ideal: true },
    autoGainControl:   { ideal: true },
    channelCount: 1,
    sampleRate: 48000,
    sampleSize: 16,
  };

  const videoConstraints = {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: 'user',
  };

  // Lấy stream với AEC constraints
  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: videoConstraints,
  });

  // Level 2: AudioContext pipeline — lọc thêm (highpass + compressor)
  // Khởi tạo WebRTCManager tạm thời để gọi applyEchoCancellation
  const tempMgr = new WebRTCManager(AppState.socket, rawStream, () => {}, () => {});
  AppState.localStream = AppState.isEchoCancellation
    ? tempMgr.applyEchoCancellation(rawStream)
    : rawStream;

  // Verify AEC status
  const audioTrack = AppState.localStream.getAudioTracks()[0];
  const settings = audioTrack?.getSettings?.() || {};
  const aecOn = settings.echoCancellation !== false;
  console.log('[Echo] AEC status:', aecOn, settings);

  // Hiển thị local video
  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = AppState.localStream;
  localVideo.muted = true;

  // Cập nhật echo UI
  updateEchoUI(AppState.isEchoCancellation);

  console.log('[App] Stream sẵn sàng | audio:', rawStream.getAudioTracks().length, '| video:', rawStream.getVideoTracks().length);
}

// ── Remote stream ──────────────────────────────────────────────────────────
function handleRemoteStream(peerId, remoteStream) {
  const peer = AppState.peers[peerId];
  if (!peer) return;
  const videoEl = peer.videoEl;
  if (videoEl) {
    videoEl.srcObject = remoteStream;
    videoEl.muted = false;
    videoEl.play().catch(() => {});
  }
  const statusEl = document.getElementById(`status-${peerId}`);
  if (statusEl) { statusEl.textContent = 'Đã kết nối'; statusEl.className = 'peer-status connected'; }
}

function handlePeerDisconnect(peerId) { removePeerFromRoom(peerId); }

// ── VIDEO GRID — chia đều theo số người ───────────────────────────────────
function updateGridLayout() {
  const wrapper = document.getElementById('video-grid-wrapper');
  if (!wrapper) return;

  // Đếm tổng tiles (không tính screenshare nếu có)
  const total = Object.keys(AppState.peers).length + 1; // +1 = mình

  if (AppState.isScreenSharing) {
    // Screenshare mode: handled by has-screenshare class
    return;
  }

  // Xóa has-screenshare nếu có
  wrapper.classList.remove('has-screenshare');

  // Gán data-count để CSS tự chia grid
  if (total <= 6) {
    wrapper.setAttribute('data-count', String(total));
  } else {
    wrapper.setAttribute('data-count', 'many');
  }
}

// ── Thêm peer vào room ─────────────────────────────────────────────────────
function addPeerToRoom(peerId, username) {
  const wrapper = document.getElementById('video-grid-wrapper');

  const container = document.createElement('div');
  container.className = 'video-container peer-video';
  container.id = `container-${peerId}`;
  container.innerHTML = `
    <video id="video-${peerId}" autoplay playsinline></video>
    <div class="video-overlay">
      <span class="peer-name">${username}</span>
      <span class="peer-status connecting" id="status-${peerId}">Đang kết nối...</span>
    </div>
    <div class="latency-badge latency-unknown" id="latency-${peerId}">
      <span class="latency-rtt">-- ms</span>
    </div>`;

  wrapper.appendChild(container);

  AppState.peers[peerId] = {
    username,
    videoEl: document.getElementById(`video-${peerId}`),
    container,
  };

  updateGridLayout();
  updateParticipantCount();
}

function removePeerFromRoom(peerId) {
  const peer = AppState.peers[peerId];
  if (peer?.container) { peer.container.remove(); delete AppState.peers[peerId]; }
  updateGridLayout();
  updateParticipantCount();
  updateLatencyTable();
}

// ── Screen Share ───────────────────────────────────────────────────────────
async function toggleScreenShare() {
  const btn = document.getElementById('btn-screen-share');
  const liveBadge = document.getElementById('screenshare-live-badge');
  const wrapper = document.getElementById('video-grid-wrapper');

  if (AppState.isScreenSharing) {
    // Dừng share
    if (AppState.screenStream) {
      AppState.screenStream.getTracks().forEach(t => t.stop());
      AppState.screenStream = null;
    }

    // Khôi phục camera track cho tất cả peer connections
    const camTrack = AppState.localStream?.getVideoTracks()[0];
    if (camTrack && AppState.webrtcManager) {
      for (const pc of Object.values(AppState.webrtcManager.peerConnections)) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(camTrack).catch(() => {});
      }
    }

    // Xóa screenshare tile
    const shareTile = document.getElementById('screenshare-tile');
    const thumbsCol = document.getElementById('thumbnails-col');
    if (shareTile) shareTile.remove();
    if (thumbsCol) {
      // Di chuyển video containers về wrapper
      while (thumbsCol.firstChild) wrapper.appendChild(thumbsCol.firstChild);
      thumbsCol.remove();
    }

    wrapper.classList.remove('has-screenshare');
    AppState.isScreenSharing = false;
    btn.classList.remove('btn-screen-active');
    btn.querySelector('.btn-label').textContent = 'Màn hình';
    btn.querySelector('.btn-icon').textContent = '🖥️';
    liveBadge.classList.add('hidden');

    updateGridLayout();
    showNotification('Đã dừng chia sẻ màn hình', 'info');
    return;
  }

  // Bắt đầu share
  try {
    AppState.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, cursor: 'always' },
      audio: false,
    });

    const screenTrack = AppState.screenStream.getVideoTracks()[0];

    // Thay video track trong tất cả peer connections
    if (AppState.webrtcManager) {
      for (const pc of Object.values(AppState.webrtcManager.peerConnections)) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack).catch(() => {});
      }
    }

    // Tạo screenshare tile lớn
    const shareTile = document.createElement('div');
    shareTile.className = 'screenshare-tile';
    shareTile.id = 'screenshare-tile';
    shareTile.innerHTML = `
      <video id="screen-video" autoplay muted playsinline></video>
      <div class="screenshare-label">🖥️ Màn hình của bạn</div>`;

    // Thu thập các video-container hiện tại vào thumbnails-col
    const thumbsCol = document.createElement('div');
    thumbsCol.className = 'thumbnails-col';
    thumbsCol.id = 'thumbnails-col';

    // Di chuyển tất cả video containers vào thumbs col
    const existingTiles = [...wrapper.querySelectorAll('.video-container')];
    existingTiles.forEach(tile => thumbsCol.appendChild(tile));

    wrapper.innerHTML = '';
    wrapper.appendChild(shareTile);
    wrapper.appendChild(thumbsCol);
    wrapper.classList.add('has-screenshare');

    // Gán stream cho tile share
    const screenVideo = document.getElementById('screen-video');
    screenVideo.srcObject = AppState.screenStream;

    AppState.isScreenSharing = true;
    btn.classList.add('btn-screen-active');
    btn.querySelector('.btn-label').textContent = 'Dừng share';
    btn.querySelector('.btn-icon').textContent = '⏹️';
    liveBadge.classList.remove('hidden');

    // Dừng share khi user click "Stop" trên browser
    screenTrack.onended = () => {
      if (AppState.isScreenSharing) toggleScreenShare();
    };

    showNotification('Đang chia sẻ màn hình', 'info');
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      showNotification('Không thể chia sẻ màn hình', 'leave');
    }
  }
}

// ── Tắt/bật Mic ───────────────────────────────────────────────────────────
function toggleMic() {
  AppState.isMicOn = !AppState.isMicOn;
  AppState.webrtcManager?.toggleAudio(AppState.isMicOn);
  const btn = document.getElementById('btn-toggle-mic');
  btn.classList.toggle('btn-off', !AppState.isMicOn);
  btn.querySelector('.btn-label').textContent = AppState.isMicOn ? 'Mic' : 'Mic (Tắt)';
  btn.querySelector('.btn-icon').textContent = AppState.isMicOn ? '🎤' : '🔇';
}

// ── Tắt/bật Camera ────────────────────────────────────────────────────────
function toggleCamera() {
  AppState.isCameraOn = !AppState.isCameraOn;
  AppState.webrtcManager?.toggleVideo(AppState.isCameraOn);
  const btn = document.getElementById('btn-toggle-cam');
  btn.classList.toggle('btn-off', !AppState.isCameraOn);
  btn.querySelector('.btn-label').textContent = AppState.isCameraOn ? 'Camera' : 'Camera (Tắt)';
  btn.querySelector('.btn-icon').textContent = AppState.isCameraOn ? '📹' : '📷';
  document.getElementById('local-video').style.opacity = AppState.isCameraOn ? '1' : '0.3';
}

// ── Echo Cancellation toggle ───────────────────────────────────────────────
function toggleEchoCancellation() {
  AppState.isEchoCancellation = !AppState.isEchoCancellation;
  updateEchoUI(AppState.isEchoCancellation);
  showNotification(
    `Echo Cancellation: ${AppState.isEchoCancellation ? 'BẬT' : 'TẮT'} (hiệu lực khi kết nối mới)`,
    'info'
  );
}

// Cập nhật TẤT CẢ echo UI indicators
function updateEchoUI(isOn) {
  // 1. Nút control bar
  const btn = document.getElementById('btn-toggle-echo');
  btn.classList.toggle('btn-active', isOn);
  btn.querySelector('.btn-label').textContent = `Echo Cancel: ${isOn ? 'BẬT' : 'TẮT'}`;

  // 2. Badge trong topbar
  const topBadge = document.getElementById('echo-topbar-badge');
  if (topBadge) {
    topBadge.className = `echo-topbar-badge ${isOn ? 'echo-on' : 'echo-off'}`;
    document.getElementById('echo-topbar-label').textContent = `Echo Cancel: ${isOn ? 'BẬT' : 'TẮT'}`;
  }

  // 3. Indicator overlay trên local video tile
  const videoIndicator = document.getElementById('echo-video-indicator');
  if (videoIndicator) {
    videoIndicator.className = `echo-active-indicator ${isOn ? '' : 'echo-off'}`;
    videoIndicator.lastChild.textContent = isOn ? ' AEC BẬT' : ' AEC TẮT';
  }

  // 4. Banner trong info tab
  const banner = document.getElementById('echo-info-banner');
  if (banner) {
    banner.className = `echo-info-banner ${isOn ? 'on' : 'off'}`;
    document.getElementById('echo-info-title').textContent = `Echo Cancellation: ${isOn ? 'BẬT' : 'TẮT'}`;
    document.getElementById('echo-info-sub').textContent = isOn
      ? 'AEC + Noise Suppression + AGC đang hoạt động'
      : 'Tắt — có thể nghe tiếng vọng khi dùng loa ngoài';
  }

  // 5. Span cũ trong info-item
  const echoStatus = document.getElementById('echo-status');
  if (echoStatus) echoStatus.textContent = isOn ? 'BẬT' : 'TẮT';
}

// ── Rời phòng ──────────────────────────────────────────────────────────────
function leaveRoom() {
  if (AppState.isScreenSharing) toggleScreenShare();
  AppState.webrtcManager?.closeAll();
  AppState.localStream?.getTracks().forEach(t => t.stop());
  AppState.localStream = null;
  AppState.socket.disconnect();
  AppState.peers = {};

  screens.meeting.classList.add('hidden');
  screens.lobby.classList.remove('hidden');

  setTimeout(() => { AppState.socket.connect(); initSocketConnection(); }, 500);

  // Reset grid
  const wrapper = document.getElementById('video-grid-wrapper');
  if (wrapper) {
    wrapper.innerHTML = `
      <div class="video-container local-video-container" id="local-container">
        <video id="local-video" autoplay muted playsinline></video>
        <div class="video-overlay">
          <span class="peer-name">Bạn (Local)</span>
          <span class="peer-status connected">🟢 Đang phát</span>
        </div>
        <div class="local-badge">YOU</div>
        <div class="echo-active-indicator" id="echo-video-indicator">
          <div class="echo-wave"><span></span><span></span><span></span><span></span><span></span></div>
          AEC BẬT
        </div>
      </div>`;
    wrapper.setAttribute('data-count', '1');
    wrapper.classList.remove('has-screenshare');
  }
  document.getElementById('latency-tbody').innerHTML = '';
  document.getElementById('btn-join').textContent = '🚀 Tham gia ngay';
  document.getElementById('btn-join').disabled = false;
}

// ── Chat ───────────────────────────────────────────────────────────────────
function sendChatMessage() {
  const input = document.getElementById('input-chat');
  const message = input.value.trim();
  if (!message || !AppState.roomId) return;
  AppState.socket.emit('chat-message', { roomId: AppState.roomId, message, username: AppState.username });
  input.value = '';
}

function displayChatMessage(message, username, isMe, timestamp) {
  const chatBox = document.getElementById('chat-messages');
  const time = new Date(timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = `chat-message ${isMe ? 'chat-me' : 'chat-other'}`;
  el.innerHTML = `<div class="chat-bubble">
    ${!isMe ? `<span class="chat-username">${username}</span>` : ''}
    <span class="chat-text">${escapeHTML(message)}</span>
    <span class="chat-time">${time}</span>
  </div>`;
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ── Latency UI ─────────────────────────────────────────────────────────────
function updateLatencyUI(peerId, stats) {
  const peer = AppState.peers[peerId];
  if (!peer) return;
  const badge = document.getElementById(`latency-${peerId}`);
  if (badge) {
    badge.querySelector('.latency-rtt').textContent = `${stats.rtt} ms`;
    badge.className = `latency-badge ${getLatencyClass(stats.rtt)}`;
  }
  updateLatencyTable();
}

function updateLatencyTable() {
  const tbody = document.getElementById('latency-tbody');
  const allStats = AppState.webrtcManager?.getAllLatencyStats() || {};
  tbody.innerHTML = '';
  for (const peerId in allStats) {
    const peer = AppState.peers[peerId];
    if (!peer) continue;
    const stats = allStats[peerId];
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${peer.username}</td>
      <td class="${getLatencyClass(stats.rtt)}">${stats.rtt} ms</td>
      <td>${stats.jitter} ms</td>
      <td>${stats.packetLoss}%</td>
      <td>${stats.framesPerSecond} fps</td>
      <td>${getLatencyLabel(stats.rtt)}</td>`;
    tbody.appendChild(row);
  }
  if (!tbody.children.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Chưa có kết nối nào...</td></tr>';
  }
}

// ── Switch to meeting screen ───────────────────────────────────────────────
function switchToMeetingScreen(roomId) {
  screens.lobby.classList.add('hidden');
  screens.meeting.classList.remove('hidden');
  document.getElementById('room-id-display').textContent = roomId;
  document.getElementById('username-display').textContent = AppState.username;
  updateGridLayout();
}

// ── Utilities ──────────────────────────────────────────────────────────────
function updateParticipantCount() {
  const count = Object.keys(AppState.peers).length + 1;
  document.getElementById('participant-count').textContent = `${count} người`;
}

function getLatencyClass(rtt) {
  if (!rtt) return 'latency-unknown';
  if (rtt < 50) return 'latency-good';
  if (rtt < 150) return 'latency-fair';
  return 'latency-poor';
}

function getLatencyLabel(rtt) {
  if (!rtt) return 'Chưa đo';
  if (rtt < 50) return '🟢 Xuất sắc';
  if (rtt < 100) return '🟡 Tốt';
  if (rtt < 150) return '🟠 Trung bình';
  return '🔴 Kém';
}

function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications');
  const el = document.createElement('div');
  el.className = `notification notification-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add('fade-out'), 3000);
  setTimeout(() => el.remove(), 3500);
}

function showLobbyError(message) {
  const el = document.getElementById('lobby-error');
  el.textContent = message; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
