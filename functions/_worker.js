// _worker.js - Pages 唯一入口（含 Durable Object + 静态文件服务）
// 命名规则：文件以 _ 开头 → 不作为路由，但参与编译

function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
function broadcast(members, msg, exclude) { for (const m of members) { if (m !== exclude) send(m, msg); } }
function genCode(rooms) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (rooms.has(code));
  return code;
}

// WebSocket 处理器（可复用：DO / 回退都用它）
function bindWs(server, rooms, roomMetas, allClients) {
  const info = { curRoom: null, curRole: null };
  allClients.add(server);
  send(server, { type: 'room_list', rooms: Array.from(roomMetas.values()) });

  const sync = () => {
    const list = Array.from(roomMetas.values());
    for (const ws of allClients) { if (ws.readyState === 1) send(ws, { type: 'room_list', rooms: list }); }
  };

  server.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'create_room': {
        if (info.curRoom) return;
        const code = genCode(rooms);
        rooms.set(code, { code, members: [server], host: server, meta: { playerCount: 1 } });
        roomMetas.set(code, { code, playerCount: 1 });
        info.curRoom = code; info.curRole = 'host';
        send(server, { type: 'room_created', code });
        sync();
        break;
      }
      case 'join_room': {
        if (info.curRoom) return;
        const room = rooms.get(msg.code);
        if (!room) { send(server, { type: 'error', message: 'room_not_found' }); break; }
        if (room.members.length >= 6) { send(server, { type: 'error', message: 'room_full' }); break; }
        room.members.push(server);
        room.meta.playerCount = room.members.length;
        roomMetas.set(msg.code, { code: msg.code, playerCount: room.members.length });
        info.curRoom = msg.code; info.curRole = 'peer';
        send(server, { type: 'room_joined', code: msg.code });
        broadcast(room.members, { type: 'peer_joined', memberCount: room.members.length }, server);
        sync();
        break;
      }
      case 'offer': { const r = rooms.get(info.curRoom); if (r) broadcast(r.members, { type: 'offer', sdp: msg.sdp }, server); break; }
      case 'answer': { const r = rooms.get(info.curRoom); if (r) broadcast(r.members, { type: 'answer', sdp: msg.sdp }, server); break; }
      case 'ice_candidate': { const r = rooms.get(info.curRoom); if (r) broadcast(r.members, { type: 'ice_candidate', candidate: msg.candidate }, server); break; }
    }
  });

  server.addEventListener('close', () => {
    allClients.delete(server);
    if (info.curRoom && rooms.has(info.curRoom)) {
      const rm = rooms.get(info.curRoom);
      rm.members = rm.members.filter(m => m !== server);
      rm.meta.playerCount = rm.members.length;
      if (rm.members.length === 0 || rm.host === server) {
        if (rm.host === server) broadcast(rm.members, { type: 'host_disconnected' });
        rooms.delete(info.curRoom); roomMetas.delete(info.curRoom);
      } else { broadcast(rm.members, { type: 'peer_left', memberCount: rm.members.length }); }
      sync();
    }
  });
  server.addEventListener('error', () => { allClients.delete(server); });
}

// ── Durable Object ──
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
    bindWs(server, this.rooms, this.roomMetas, this.allClients);
    return new Response(null, { status: 101, webSocket: client });
  }
}

// ── 请求处理器 ──
function handleSignal(request, rooms, roomMetas, allClients) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  bindWs(server, rooms, roomMetas, allClients);
  return new Response(null, { status: 101, webSocket: client });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === '/signal') {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    // 尝试使用 Durable Object（跨隔离共享）
    if (env && env.SIGNAL_ROOM) {
      try {
        const id = env.SIGNAL_ROOM.idFromName('global');
        const stub = env.SIGNAL_ROOM.get(id);
        const response = await stub.fetch(request);
        return response;
      } catch (e) {
        // DO 不可用，回退
      }
    }
    // 回退版本
    return handleSignal(request, new Map(), new Map(), new Set());
  }

  if (url.pathname === '/do-test') {
    // DO 可用性测试
    let doOk = false;
    try {
      if (env && env.SIGNAL_ROOM) {
        const id = env.SIGNAL_ROOM.idFromName('test');
        const stub = env.SIGNAL_ROOM.get(id);
        doOk = true;
      }
    } catch (e) {}
    return new Response(JSON.stringify({ durableObject: doOk ? 'available' : 'unavailable' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 静态文件
  return env.ASSETS.fetch(request);
}
