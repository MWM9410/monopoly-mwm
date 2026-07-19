// Cloudflare Worker 版信令服务器 (WebSocket)
// 用于纯前端部署：无需自建 Node 服务器
// 部署：wrangler deploy
// 依赖：需要 Workers 付费计划或支持 WebSocket 的计划

const ROOM_CODE_LENGTH = 5;
const ROOM_TTL = 1000 * 60 * 30; // 房间 30 分钟无活动自动清理

// 用 Durable Object 或全局状态保存房间列表
// 这里用 Worker 全局 Map（单实例场景足够；多实例请用 Durable Objects）
const rooms = new Map();        // code -> { members: [ws], host: ws, meta: {playerCount} }
const roomMetas = new Map();    // code -> { code, playerCount }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) {}
}

function broadcast(room, msg, exclude = null) {
  for (const member of room.members) {
    if (member !== exclude) send(member, msg);
  }
}

function getRoomList() {
  return Array.from(roomMetas.values());
}

function syncRoomList() {
  const list = getRoomList();
  for (const pair of rooms) {
    const members = pair[1].members;
    for (const m of members) send(m, { type: 'room_list', rooms: list });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, rooms: rooms.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 仅支持 WebSocket 升级
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket connection', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    handleConnection(server, ctx);

    return new Response(null, { status: 101, webSocket: client });
  }
};

function handleConnection(ws, ctx) {
  let currentRoom = null;
  let currentRole = null;

  // 新连接立即推送房间列表
  send(ws, { type: 'room_list', rooms: getRoomList() });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { send(ws, { type: 'error', message: 'invalid_json' }); return; }

    switch (msg.type) {
      case 'create_room': {
        if (currentRoom) { send(ws, { type: 'error', message: 'already_in_room' }); break; }
        const code = generateRoomCode();
        rooms.set(code, { code, members: [ws], host: ws, meta: { playerCount: 1 } });
        roomMetas.set(code, { code, playerCount: 1 });
        currentRoom = code;
        currentRole = 'host';
        send(ws, { type: 'room_created', code });
        syncRoomList();
        console.log(`[信号] 创建房间 ${code}`);
        break;
      }
      case 'join_room': {
        if (currentRoom) { send(ws, { type: 'error', message: 'already_in_room' }); break; }
        const room = rooms.get(msg.code);
        if (!room) { send(ws, { type: 'error', message: 'room_not_found' }); break; }
        if (room.members.length >= 8) { send(ws, { type: 'error', message: 'room_full' }); break; }
        room.members.push(ws);
        room.meta.playerCount = room.members.length;
        currentRoom = msg.code;
        currentRole = 'peer';
        send(ws, { type: 'room_joined', code: msg.code });
        broadcast(room, { type: 'peer_joined', memberCount: room.members.length }, ws);
        syncRoomList();
        console.log(`[信号] 加入房间 ${msg.code} (${room.members.length}人)`);
        break;
      }
      case 'register_peer_id': {
        ws._peerId = msg.peerId;
        break;
      }
      case 'offer': {
        const room = rooms.get(currentRoom);
        if (!room) break;
        broadcast(room, { type: 'offer', sdp: msg.sdp, fromRole: currentRole });
        break;
      }
      case 'answer': {
        const room = rooms.get(currentRoom);
        if (!room) break;
        broadcast(room, { type: 'answer', sdp: msg.sdp, fromRole: currentRole });
        break;
      }
      case 'ice_candidate': {
        const room = rooms.get(currentRoom);
        if (!room) break;
        broadcast(room, { type: 'ice_candidate', candidate: msg.candidate, fromRole: currentRole });
        break;
      }
      default:
        send(ws, { type: 'error', message: 'unknown_type' });
    }
  });

  ws.addEventListener('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.members = room.members.filter(m => m !== ws);
      room.meta.playerCount = room.members.length;
      if (room.members.length === 0) {
        rooms.delete(currentRoom);
        roomMetas.delete(currentRoom);
        console.log(`[信号] 房间 ${currentRoom} 已关闭`);
      } else if (room.host === ws) {
        broadcast(room, { type: 'host_disconnected' });
        rooms.delete(currentRoom);
        roomMetas.delete(currentRoom);
        console.log(`[信号] 主机断开，房间 ${currentRoom} 已关闭`);
      } else {
        broadcast(room, { type: 'peer_left', memberCount: room.members.length });
        console.log(`[信号] 玩家离开 ${currentRoom} (${room.members.length}人)`);
      }
      syncRoomList();
    }
  });

  ws.addEventListener('error', () => {});
}
