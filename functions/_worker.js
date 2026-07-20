// _worker.js - 唯一 Pages Function 入口
// 包含 Durable Object (SignalRoom) + 请求路由

// ──────────── Durable Object ────────────
function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
function broadcast(members, msg, exclude) { for (const m of members) { if (m !== exclude) send(m, msg); } }

function genCode(rooms) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (rooms.has(code));
  return code;
}

function addWsHandler(server, rooms, roomMetas, allClients) {
  const info = { currentRoom: null, currentRole: null };
  allClients.add(server);
  send(server, { type: 'room_list', rooms: Array.from(roomMetas.values()) });

  const syncRoomList = () => {
    const list = Array.from(roomMetas.values());
    for (const ws of allClients) { if (ws.readyState === 1) send(ws, { type: 'room_list', rooms: list }); }
  };

  server.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'create_room': {
        if (info.currentRoom) return;
        const code = genCode(rooms);
        rooms.set(code, { code, members: [server], host: server, meta: { playerCount: 1 } });
        roomMetas.set(code, { code, playerCount: 1 });
        info.currentRoom = code; info.currentRole = 'host';
        send(server, { type: 'room_created', code });
        syncRoomList();
        break;
      }
      case 'join_room': {
        if (info.currentRoom) return;
        const room = rooms.get(msg.code);
        if (!room) { send(server, { type: 'error', message: 'room_not_found' }); break; }
        room.members.push(server);
        room.meta.playerCount = room.members.length;
        info.currentRoom = msg.code; info.currentRole = 'peer';
        send(server, { type: 'room_joined', code: msg.code });
        broadcast(room.members, { type: 'peer_joined', memberCount: room.members.length }, server);
        syncRoomList();
        break;
      }
      case 'offer': { const r = rooms.get(info.currentRoom); if (r) broadcast(r.members, { type: 'offer', sdp: msg.sdp }, server); break; }
      case 'answer': { const r = rooms.get(info.currentRoom); if (r) broadcast(r.members, { type: 'answer', sdp: msg.sdp }, server); break; }
      case 'ice_candidate': { const r = rooms.get(info.currentRoom); if (r) broadcast(r.members, { type: 'ice_candidate', candidate: msg.candidate }, server); break; }
    }
  });

  server.addEventListener('close', () => {
    allClients.delete(server);
    if (info.currentRoom && rooms.has(info.currentRoom)) {
      const room = rooms.get(info.currentRoom);
      room.members = room.members.filter(m => m !== server);
      room.meta.playerCount = room.members.length;
      if (room.members.length === 0 || room.host === server) {
        if (room.host === server) broadcast(room.members, { type: 'host_disconnected' });
        rooms.delete(info.currentRoom);
        roomMetas.delete(info.currentRoom);
      } else {
        broadcast(room.members, { type: 'peer_left', memberCount: room.members.length });
      }
      syncRoomList();
    }
  });
  server.addEventListener('error', () => { allClients.delete(server); });
}

// Durable Object 类
export class SignalRoom {
  constructor(state, env) {
    this.state = state;
    this.rooms = new Map();
    this.roomMetas = new Map();
    this.allClients = new Set();
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    addWsHandler(server, this.rooms, this.roomMetas, this.allClients);
    return new Response(null, { status: 101, webSocket: client });
  }
}

// ──────────── 请求路由 ────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 信令 WebSocket → 使用 Durable Object（所有连接共享状态）
    if (url.pathname === '/signal') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      if (env && env.SIGNAL_ROOM) {
        const id = env.SIGNAL_ROOM.idFromName('global');
        const stub = env.SIGNAL_ROOM.get(id);
        return stub.fetch(request);
      }
      // 回退：进程内内存（同一隔离内的连接可互通）
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      addWsHandler(server, new Map(), new Map(), new Set());
      return new Response(null, { status: 101, webSocket: client });
    }

    // 其他路径 → 由 Pages 自动托管静态文件
    return env.ASSETS.fetch(request);
  }
};
