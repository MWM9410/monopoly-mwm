// Pages Function - 信令服务器 (WebSocket)
// 部署在 Cloudflare Pages 同域名下：wss://xxx.pages.dev/signal

const ROOM_CODE_LENGTH = 5;
const rooms = new Map();
const roomMetas = new Map();
const allClients = new Set();

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
  for (const ws of allClients) send(ws, { type: 'room_list', rooms: list });
}

function handleConnection(ws) {
  let currentRoom = null;
  let currentRole = null;
  allClients.add(ws);

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
    allClients.delete(ws);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.members = room.members.filter(m => m !== ws);
      room.meta.playerCount = room.members.length;
      if (room.members.length === 0) {
        rooms.delete(currentRoom);
        roomMetas.delete(currentRoom);
      } else if (room.host === ws) {
        broadcast(room, { type: 'host_disconnected' });
        rooms.delete(currentRoom);
        roomMetas.delete(currentRoom);
      } else {
        broadcast(room, { type: 'peer_left', memberCount: room.members.length });
      }
      syncRoomList();
    }
  });

  ws.addEventListener('error', () => { allClients.delete(ws); });
}

export async function onRequest(context) {
  const { request } = context;
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket connection', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  handleConnection(server);
  return new Response(null, { status: 101, webSocket: client });
}
