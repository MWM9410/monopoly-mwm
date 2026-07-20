// Pages Function - 信令服务器 (WebSocket)
// 优先使用 Durable Object 共享状态，否则回退到进程内内存

const ROOM_CODE_LENGTH = 5;

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) {}
}

function broadcast(members, msg, exclude = null) {
  for (const m of members) {
    if (m !== exclude) send(m, msg);
  }
}

function genCode(rooms) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// ── 回退版本：进程内内存（无跨隔离共享） ──
const fallbackImpl = {
  rooms: new Map(),
  roomMetas: new Map(),
  allClients: new Set(),
  getRoomList() { return Array.from(this.roomMetas.values()); },
  syncRoomList() {
    const list = this.getRoomList();
    for (const ws of this.allClients) {
      if (ws.readyState === 1) send(ws, { type: 'room_list', rooms: list });
    }
  }
};

function handleFallback(server) {
  const info = { currentRoom: null, currentRole: null };
  const ctx = fallbackImpl;
  ctx.allClients.add(server);
  send(server, { type: 'room_list', rooms: ctx.getRoomList() });

  server.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { send(server, { type: 'error', message: 'invalid_json' }); return; }
    switch (msg.type) {
      case 'create_room': {
        if (info.currentRoom) { send(server, { type: 'error', message: 'already_in_room' }); break; }
        const code = genCode(ctx.rooms);
        ctx.rooms.set(code, { code, members: [server], host: server, meta: { playerCount: 1 } });
        ctx.roomMetas.set(code, { code, playerCount: 1 });
        info.currentRoom = code; info.currentRole = 'host';
        send(server, { type: 'room_created', code });
        ctx.syncRoomList();
        break;
      }
      case 'join_room': {
        if (info.currentRoom) { send(server, { type: 'error', message: 'already_in_room' }); break; }
        const room = ctx.rooms.get(msg.code);
        if (!room) { send(server, { type: 'error', message: 'room_not_found' }); break; }
        if (room.members.length >= 8) { send(server, { type: 'error', message: 'room_full' }); break; }
        room.members.push(server);
        room.meta.playerCount = room.members.length;
        info.currentRoom = msg.code; info.currentRole = 'peer';
        send(server, { type: 'room_joined', code: msg.code });
        broadcast(room.members, { type: 'peer_joined', memberCount: room.members.length }, server);
        ctx.syncRoomList();
        break;
      }
      case 'offer': {
        const room = ctx.rooms.get(info.currentRoom);
        if (!room) break;
        broadcast(room.members, { type: 'offer', sdp: msg.sdp, fromRole: info.currentRole }, server);
        break;
      }
      case 'answer': {
        const room = ctx.rooms.get(info.currentRoom);
        if (!room) break;
        broadcast(room.members, { type: 'answer', sdp: msg.sdp, fromRole: info.currentRole }, server);
        break;
      }
      case 'ice_candidate': {
        const room = ctx.rooms.get(info.currentRoom);
        if (!room) break;
        broadcast(room.members, { type: 'ice_candidate', candidate: msg.candidate, fromRole: info.currentRole }, server);
        break;
      }
    }
  });

  server.addEventListener('close', () => {
    ctx.allClients.delete(server);
    if (info.currentRoom && ctx.rooms.has(info.currentRoom)) {
      const room = ctx.rooms.get(info.currentRoom);
      room.members = room.members.filter(m => m !== server);
      room.meta.playerCount = room.members.length;
      if (room.members.length === 0) {
        ctx.rooms.delete(info.currentRoom);
        ctx.roomMetas.delete(info.currentRoom);
      } else if (room.host === server) {
        broadcast(room.members, { type: 'host_disconnected' });
        ctx.rooms.delete(info.currentRoom);
        ctx.roomMetas.delete(info.currentRoom);
      } else {
        broadcast(room.members, { type: 'peer_left', memberCount: room.members.length });
      }
      ctx.syncRoomList();
    }
  });
  server.addEventListener('error', () => { ctx.allClients.delete(server); });
}

export async function onRequest(context) {
  const { request, env } = context;

  // 尝试使用 Durable Object（跨隔离共享状态）
  if (env && env.SIGNAL_ROOM && typeof env.SIGNAL_ROOM.idFromName === 'function') {
    try {
      const id = env.SIGNAL_ROOM.idFromName('global');
      const stub = env.SIGNAL_ROOM.get(id);
      return stub.fetch(request);
    } catch (e) {
      // DO 不可用，回退
    }
  }

  // 回退：进程内内存（同一隔离内多个连接可互通）
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket connection', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  handleFallback(server);
  return new Response(null, { status: 101, webSocket: client });
}
