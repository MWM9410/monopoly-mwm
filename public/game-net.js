// GameNet - WebRTC 网络层
(function() {
  'use strict';

  // TURN 服务器配置（跨 NAT / 异地联机必需）
  // 方式一：在页面 URL 加 ?turn=url&turnuser=xxx&turnpass=yyy
  // 方式二：localStorage 设置 monopoly_turn = JSON.stringify({url, username, credential})
  // 方式三：直接改下面默认值（部署后）
  function getTurnServers() {
    let turn = null;
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('turn')) {
        turn = {
          url: params.get('turn'),
          username: params.get('turnuser') || '',
          credential: params.get('turnpass') || ''
        };
      }
    } catch (e) {}
    if (!turn) {
      try {
        const saved = localStorage.getItem('monopoly_turn');
        if (saved) turn = JSON.parse(saved);
      } catch (e) {}
    }
    if (!turn && window.__TURN_CONFIG) turn = window.__TURN_CONFIG;
    if (turn && turn.url) {
      return [{
        urls: turn.url,
        username: turn.username || '',
        credential: turn.credential || ''
      }];
    }
    return [];
  }

  const C = {
    RTC_CONFIG: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.google.com:19302' },
        ...getTurnServers()
      ]
    }
  };


class EventEmitter {
  constructor() { this._ls = {}; }
  on(e, cb) { if (!this._ls[e]) this._ls[e] = []; this._ls[e].push(cb); return this; }
  off(e, cb) { if (!this._ls[e]) return; this._ls[e] = this._ls[e].filter(f => f !== cb); return this; }
  _emit(e, ...a) { const h = this._ls[e] || []; for (const cb of h) cb(...a); }
  _emitAll(e, ...a) {
    this._emit(e, ...a);
    if (e !== '*') { const w = this._ls['*'] || []; for (const cb of w) cb(e, ...a); }
  }
}

class WebRtcChannel extends EventEmitter {
  constructor(dc) {
    super();
    this._dc = dc;
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this._emitAll(msg.event, msg.data);
      } catch(err) {
        if (e.data) this._emitAll('raw', e.data);
      }
    };
    dc.onclose = () => this._emit('disconnected');
  }
  emit(event, data) {
    if (this._dc && this._dc.readyState === 'open') {
      this._dc.send(JSON.stringify({ event, data }));
    }
  }
}

const GameNet = {
  _dataChannels: [],
  _peerSockets: new Map(), // dataChannel -> engineSocket

  // 创建房间（信号连接 + WebRTC 监听）
  createHost(signalUrl) {
    const self = this;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(signalUrl);
      let resolved = false;
      let latestPC = null;
      const emitter = new EventEmitter();

      const result = {
        roomCode: null,
        on: (ev, cb) => emitter.on(ev, cb),
        // 占位：主机 socket 创建后调用（实际广播通过 peer socket 的 sendCallback 自动完成）
        registerHostSocket: () => {},
        get peerCount() { return self._dataChannels.length; }
      };

      const setupPeerSocket = (dc) => {
        self._dataChannels.push(dc);
        const peerId = 'peer_' + Date.now() + '_' + self._dataChannels.length;
        const ch = new WebRtcChannel(dc);
        const createPeer = () => {
          const peerSocket = window.GameEngine.createPlayerSocket(peerId, (ev, data) => {
            ch.emit(ev, data);
          });
          self._peerSockets.set(dc, peerSocket);
          ch.on('*', (ev, data) => {
            const handlers = peerSocket._handlers[ev] || [];
            for (const h of handlers) h(data);
          });
        };
        if (window.GameEngine && window.GameEngine._ready) createPeer();
        else window.GameEngine.onEngineReady(createPeer);
        dc.onopen = () => emitter._emit('peer_connected', peerId);
        dc.onclose = () => emitter._emit('peer_disconnected', peerId);
      };

      ws.onopen = () => ws.send(JSON.stringify({ type: 'create_room' }));

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'room_created': {
            result.roomCode = msg.code;
            if (!resolved) { resolved = true; resolve(result); }
            break;
          }
          case 'offer': {
            latestPC = new RTCPeerConnection(C.RTC_CONFIG);
            latestPC.onicecandidate = (ev) => {
              if (ev.candidate) ws.send(JSON.stringify({ type: 'ice_candidate', candidate: ev.candidate }));
            };
            latestPC.ondatachannel = (event) => setupPeerSocket(event.channel);
            latestPC.setRemoteDescription(new RTCSessionDescription(msg.sdp))
              .then(() => latestPC.createAnswer())
              .then(answer => latestPC.setLocalDescription(answer))
              .then(() => ws.send(JSON.stringify({ type: 'answer', sdp: latestPC.localDescription })));
            break;
          }
          case 'ice_candidate': {
            if (latestPC && msg.candidate) {
              latestPC.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
            }
            break;
          }
        }
      };

      ws.onerror = () => { if (!resolved) reject(new Error('信号服务器连接失败')); };
      setTimeout(() => { if (!resolved) reject(new Error('创建房间超时')); }, 10000);
    });
  },

  // 加入房间
  joinRoom(signalUrl, roomCode) {
    const self = this;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(signalUrl);
      let resolved = false;
      let rtcPC = null;
      const emitter = new EventEmitter();

      const result = {
        on: (ev, cb) => emitter.on(ev, cb),
        emit: function() {},
        id: null
      };

      ws.onopen = () => ws.send(JSON.stringify({ type: 'join_room', code: roomCode }));

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'room_joined': {
            rtcPC = new RTCPeerConnection(C.RTC_CONFIG);
            const dc = rtcPC.createDataChannel('game');
            dc.onopen = () => {
              const ch = new WebRtcChannel(dc);
              result.emit = (ev, data) => ch.emit(ev, data);
              ch.on('*', (ev, data) => emitter._emitAll(ev, data));
              emitter._emit('ready');
              if (!resolved) { resolved = true; resolve(result); }
            };
            rtcPC.onicecandidate = (ev) => {
              if (ev.candidate) ws.send(JSON.stringify({ type: 'ice_candidate', candidate: ev.candidate }));
            };
            rtcPC.createOffer()
              .then(offer => rtcPC.setLocalDescription(offer))
              .then(() => ws.send(JSON.stringify({ type: 'offer', sdp: rtcPC.localDescription })));
            break;
          }
          case 'answer': {
            if (rtcPC && msg.sdp) rtcPC.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            break;
          }
          case 'ice_candidate': {
            if (rtcPC && msg.candidate) rtcPC.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
            break;
          }
          case 'host_disconnected': emitter._emit('host_disconnected'); break;
        }
      };

      ws.onerror = () => { if (!resolved) reject(new Error('信号服务器连接失败')); };
      setTimeout(() => { if (!resolved) reject(new Error('加入房间超时')); }, 15000);
    });
  },

  _closeAll() {
    this._dataChannels = [];
    this._peerSockets.clear();
  }
};

// 监听房间列表（返回 EventEmitter，emit 'update' 时携带 rooms 数组）
GameNet.watchRooms = function(signalUrl) {
  const emitter = new EventEmitter();
  let ws = null;
  function connect() {
    ws = new WebSocket(signalUrl);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'room_list') emitter._emit('update', msg.rooms || []);
      } catch(err) { /* ignore parse errors */ }
    };
    ws.onclose = () => {
      // 断线后 3 秒重连
      setTimeout(connect, 3000);
    };
    ws.onerror = () => {};
  }
  connect();
  return {
    on: (ev, cb) => emitter.on(ev, cb),
    close: () => { if (ws) { ws.onclose = null; ws.close(); } }
  };
};

window.GameNet = GameNet;
console.log('[GameNet] loaded');

})();
