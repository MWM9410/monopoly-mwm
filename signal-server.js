// Signal Server - WebRTC 信令中继 + 房间列表（无游戏逻辑）
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;
const ROOM_CODE_LENGTH = 5;

const rooms = {};         // code -> { code, members: [ws], host: ws }
const roomMetas = {};     // code -> { code, playerCount } 用于广播

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exclude = null) {
  for (const ws of room.members) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) send(ws, msg);
  }
}

function broadcastAll(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) send(client, msg);
  });
}

function getRoomList() {
  return Object.values(roomMetas);
}

function syncRoomList() {
  broadcastAll({ type: 'room_list', rooms: getRoomList() });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: Object.keys(rooms).length }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;

  // 新连接立即推送房间列表
  send(ws, { type: 'room_list', rooms: getRoomList() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'invalid_json' }); }

    switch (msg.type) {

      case 'create_room': {
        if (currentRoom) return send(ws, { type: 'error', message: 'already_in_room' });
        const code = generateRoomCode();
        rooms[code] = { code, members: [ws], host: ws };
        roomMetas[code] = { code, playerCount: 1 };
        currentRoom = code;
        currentRole = 'host';
        send(ws, { type: 'room_created', code });
        syncRoomList();
        console.log(`[信号] 创建房间 ${code}`);
        break;
      }

      case 'join_room': {
        if (currentRoom) return send(ws, { type: 'error', message: 'already_in_room' });
        const room = rooms[msg.code];
        if (!room) return send(ws, { type: 'error', message: 'room_not_found' });
        if (room.members.length >= 8) return send(ws, { type: 'error', message: 'room_full' });
        room.members.push(ws);
        roomMetas[msg.code].playerCount = room.members.length;
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
        const room = rooms[currentRoom];
        if (!room) return;
        broadcast(room, { type: 'offer', sdp: msg.sdp, fromRole: currentRole });
        break;
      }

      case 'answer': {
        broadcast(rooms[currentRoom], { type: 'answer', sdp: msg.sdp, fromRole: currentRole });
        break;
      }

      case 'ice_candidate': {
        broadcast(rooms[currentRoom], { type: 'ice_candidate', candidate: msg.candidate, fromRole: currentRole });
        break;
      }

      default:
        send(ws, { type: 'error', message: 'unknown_type' });
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      room.members = room.members.filter(m => m !== ws);
      roomMetas[currentRoom].playerCount = room.members.length;
      if (room.members.length === 0) {
        delete rooms[currentRoom];
        delete roomMetas[currentRoom];
        console.log(`[信号] 房间 ${currentRoom} 已关闭`);
      } else if (room.host === ws) {
        broadcast(room, { type: 'host_disconnected' });
        delete rooms[currentRoom];
        delete roomMetas[currentRoom];
        console.log(`[信号] 主机断开，房间 ${currentRoom} 已关闭`);
      } else {
        broadcast(room, { type: 'peer_left', memberCount: room.members.length });
        console.log(`[信号] 玩家离开 ${currentRoom} (${room.members.length}人)`);
      }
      syncRoomList();
    }
  });
});

server.listen(PORT, () => {
  console.log(`信号服务器启动 ws://0.0.0.0:${PORT}`);
});
