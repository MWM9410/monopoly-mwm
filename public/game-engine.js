// Game Engine - 纯前端大富翁引擎
// 提供 Node.js polyfill + socket.io mock + 引擎 API
(function() {
'use strict';

// ============================================================
// Part 1: 全局 Polyfill（在 server-browser.js 加载前就绪）
// ============================================================

// process
if (typeof window.process === 'undefined') {
  window.process = {
    env: { CLOUD: 'true', RENDER: 'true', PORT: '0' },
    exit: function() {},
    versions: {},
    nextTick: function(fn) { setTimeout(fn, 0); },
    argv: [],
    stdout: { write: function() {} },
    stderr: { write: function() {} }
  };
}

// path
if (typeof window.path === 'undefined') {
  window.path = {
    join: function() { return Array.from(arguments).filter(Boolean).join('/').replace(/\/+/g, '/'); },
    dirname: function(p) { return p.substring(0, p.lastIndexOf('/')) || '.'; },
    basename: function(p) { return p.split('/').pop(); },
    resolve: function() { return Array.from(arguments).filter(Boolean).join('/'); }
  };
}

// fs (in-memory + localStorage fallback)
if (typeof window.fs === 'undefined') {
  const fsStore = {};
  window.fs = {
    readFileSync: function(filepath, encoding) {
      if (filepath === 'mingzi.txt' && window.__MINGZI_CONTENT) return window.__MINGZI_CONTENT;
      return fsStore[filepath] || '';
    },
    writeFileSync: function(filepath, data) {
      fsStore[filepath] = data;
      try { localStorage.setItem('_fs_' + filepath, data); } catch(e) {}
    },
    existsSync: function(filepath) {
      return fsStore[filepath] !== undefined || (filepath === 'mingzi.txt' && !!window.__MINGZI_CONTENT);
    },
    unlinkSync: function(filepath) {
      delete fsStore[filepath];
      try { localStorage.removeItem('_fs_' + filepath); } catch(e) {}
    },
    mkdirSync: function() {},
    readdirSync: function() { return []; }
  };
}

// express mock
if (typeof window.express === 'undefined') {
  window.express = function() {
    const app = function() {};
    app.use = function() {};
    app.get = function() {};
    app.post = function() {};
    app.listen = function() { return { on: function() {} }; };
    return app;
  };
  window.express.static = function() { return function() {}; };
}

// http / https mock
if (typeof window.http === 'undefined') {
  window.http = {
    createServer: function() {
      return { on: function() {}, listen: function(port, cb) { if (cb) setTimeout(cb, 0); } };
    }
  };
  window.https = {
    createServer: function() {
      return { on: function() {}, listen: function(port, cb) { if (cb) setTimeout(cb, 0); } };
    }
  };
}

// node-forge mock
if (typeof window.forge === 'undefined') {
  window.forge = {
    pki: {
      rsa: { generateKeyPair: function() { return { privateKey: '', publicKey: '' }; } },
      createCertificate: function() { return { publicKey: '', serialNumber: '', validity: {}, sign: function() {} }; },
      privateKeyToPem: function() { return ''; },
      certificateToPem: function() { return ''; }
    }
  };
}

// mingzi.txt 内联
window.__MINGZI_CONTENT = [
  '史，猪，区，闯哥，牛，鸡，包的，恐高，牢，苦命，鲨马，憨厚，带派，空虚，微胖，抠脚，嘴硬，哇哇，嘟嘟，嘎嘎，摆烂，社恐，拉屎，心机，批，浓泻，露出，只好，不，弱鸡，丝袜，地沟，焦虑，QQ，多嘴，真的，蟑螂，吃醋，软脚，家人，叛逆，孝顺，小，粗鄙，装，确实，开心，骚，超雄，赎罪，冒充，出卖，张得，妈的，争宠，拼，避孕',
  '真香，霸霸，摸摸，哈哈，吉米，旺财，魔仙，大大，二奶，姨妈，癫疯，太美，村花，狗剩，啾咪，哔哔，飘飘，菊花，包子，笑，偷油，喵喵，奶昔，大肠，傲天，求佛，陀螺，诡蜜，老实，雨姐，酱，熬夜，尬尬，自信，摆摆，人，精，西哇，仙女，鸭，咸鱼，了，后妈，尼姑，嗨，老哥，老妹，老弟，喊冤，大腿，咪，怪，爆了，他么，闺闺，芭比，懂哥，婆，闹麻，王，滂臭，沟槽，娇娇，波伊，波润，白嫖，大爸',
  ''
].join('\n');

// ============================================================
// Part 2: Socket.IO Mock（完整模拟）
// ============================================================

let _socketCounter = 0;

class MockSocket {
  constructor(id) {
    this.id = id || 'mock-socket-' + (++_socketCounter);
    this._handlers = {};
    this.rooms = new Set();
    this.data = {};
    this._sendCallback = null; // function(event, ...args) 发送到真实客户端
    this._cleanupCallbacks = [];
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  emit(event, ...args) {
    // 触发本地 handlers（游戏引擎派发事件到 game.js）
    if (this._handlers[event]) {
      const hs = this._handlers[event];
      for (let i = 0; i < hs.length; i++) hs[i](...args);
    }
    // 发送到绑定的真实客户端（WebRTC 转发）
    if (this._sendCallback) {
      this._sendCallback(event, ...args);
    }
    // 全局监听
    if (window.GameEngine && window.GameEngine._onSocketEmit) {
      window.GameEngine._onSocketEmit(this, event, ...args);
    }
    return this;
  }

  join(room) {
    this.rooms.add(room);
    return this;
  }

  leave(room) {
    this.rooms.delete(room);
    return this;
  }

  to(room) {
    const self = this;
    return {
      emit(event, ...args) {
        const io = window.__gameIo;
        if (!io) return;
        for (const [sid, sock] of io.sockets.sockets) {
          if (sid !== self.id && sock.rooms && sock.rooms.has(room)) {
            sock.emit(event, ...args);
          }
        }
      }
    };
  }

  get broadcast() {
    const self = this;
    return {
      emit(event, ...args) {
        const io = window.__gameIo;
        if (!io) return;
        for (const [sid, sock] of io.sockets.sockets) {
          if (sid !== self.id) {
            sock.emit(event, ...args);
          }
        }
      }
    };
  }

  disconnect() {
    for (const cb of this._cleanupCallbacks) cb(this);
  }

  _addCleanup(cb) { this._cleanupCallbacks.push(cb); }
}

class MockServer {
  constructor(options) {
    this.connectionHandlers = [];
    this.sockets = {
      sockets: new Map(),
      forEach: function(cb) { this.sockets.forEach(cb); }
    };
    this._options = options || {};
  }

  on(event, handler) {
    if (event === 'connection') {
      this.connectionHandlers.push(handler);
    }
    return this;
  }

  emit(event, ...args) {
    // 广播到所有socket
    for (const [id, socket] of this.sockets.sockets) {
      socket.emit(event, ...args);
    }
    return this;
  }

  to(target) {
    const self = this;
    return {
      emit(event, ...args) {
        const socket = self.sockets.sockets.get(target);
        if (socket) socket.emit(event, ...args);
      }
    };
  }

  attach() { return this; }

  get engine() {
    return { clientsCount: this.sockets.sockets.size };
  }

  // ============ 引擎 API ============

  createSocket(id, sendCallback) {
    const socket = new MockSocket(id);
    socket._sendCallback = sendCallback || null;
    this.sockets.sockets.set(socket.id, socket);

    // 调用所有 connection handlers
    for (const handler of this.connectionHandlers) {
      handler(socket);
    }

    return socket;
  }

  removeSocket(id) {
    this.sockets.sockets.delete(id);
  }
}

// ============================================================
// Part 3: require polyfill
// ============================================================
if (typeof window.require === 'undefined') {
  window.require = function(moduleName) {
    switch (moduleName) {
      case 'express': return window.express;
      case 'http': return window.http;
      case 'https': return window.https;
      case 'socket.io': return window.__socketioMock;
      case 'path': return window.path;
      case 'fs': return window.fs;
      case 'node-forge': return window.forge;
      default:
        console.warn('[Engine] Unknown require:', moduleName);
        return {};
    }
  };
}

// ============================================================
// Part 4: Socket.io mock module
// ============================================================
if (typeof window.__socketioMock === 'undefined') {
  window.__socketioMock = {
    Server: MockServer,
    Socket: MockSocket
  };
}

// ============================================================
// Part 5: GameEngine API
// ============================================================
const GameEngine = {
  _ready: false,
  _io: null,            // 由 server-browser.js 赋值
  _engineReadyCallbacks: [],

  // server-browser.js 加载完毕后调用
  onEngineReady(callback) {
    if (this._ready) { setTimeout(callback, 0); return; }
    this._engineReadyCallbacks.push(callback);
  },

  _setReady() {
    this._ready = true;
    this._io = window.__gameIo;
    for (const cb of this._engineReadyCallbacks) setTimeout(cb, 0);
    this._engineReadyCallbacks = [];
  },

  // 主机：创建玩家socket
  createPlayerSocket(playerId, sendCallback) {
    if (!this._io) {
      console.error('[Engine] Engine not ready');
      return null;
    }
    return this._io.createSocket(playerId, sendCallback);
  },

  // 主机：移除玩家socket
  removePlayerSocket(playerId) {
    if (this._io) this._io.removeSocket(playerId);
  },

  // 处理来自某玩家的动作（WebRTC 远程玩家）
  processAction(socketId, event, data) {
    if (!this._io) return;
    const socket = this._io.sockets.sockets.get(socketId);
    if (!socket) {
      console.warn('[Engine] Socket not found:', socketId);
      return;
    }
    const handlers = socket._handlers[event];
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
  },

  get io() { return this._io; },

  get players() { return window.players || []; },
  get board() { return window.board || []; },
  get gameState() { return window.gameState || 'waiting'; },
  get currentPlayerIndex() { return window.currentPlayerIndex; }
};

window.GameEngine = GameEngine;

// 监听 server-browser.js 就绪事件
Object.defineProperty(window, '__gameEngineReady', {
  set: function(val) {
    if (val === true) GameEngine._setReady();
  },
  configurable: true
});

console.log('[Engine] game-engine.js loaded');

})();
