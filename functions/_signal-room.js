// Durable Object - 信令服务器状态
const ROOM_CODE_LENGTH = 5;

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) {}
}

function broadcast(members, msg, exclude = null) {
  for (const m of members) {
    if (m !== exclude && m.readyState === 1) send(m, msg);
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

export class SignalRoom {
  constructor(state, env) {
    this.state = state;
    this.rooms = new Map();
    this.roomMetas = new Map();
    this.allClients = new Set();
  }

  getRoomList() {
    return Array.from(this.roomMetas.values());
  }

  syncRoomList() {
    const list = this.getRoomList();
    for (const ws of this.allClients) {
      if (ws.readyState === 1) send(ws, { type: 'room_list', rooms: list });
    }
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const info = { currentRoom: null, currentRole: null };
    this.allClients.add(server);

    send(server, { type: 'room_list', rooms: this.getRoomList() });

    server.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { send(server, { type: 'error', message: 'invalid_json' }); return; }

      switch (msg.type) {
        case 'create_room': {
          if (info.currentRoom) { send(server, { type: 'error', message: 'already_in_room' }); break; }
          const code = genCode(this.rooms);
          this.rooms.set(code, { code, members: [server], host: server, meta: { playerCount: 1 } });
          this.roomMetas.set(code, { code, playerCount: 1 });
          info.currentRoom = code;
          info.currentRole = 'host';
          send(server, { type: 'room_created', code });
          this.syncRoomList();
          break;
        }
        case 'join_room': {
          if (info.currentRoom) { send(server, { type: 'error', message: 'already_in_room' }); break; }
          const room = this.rooms.get(msg.code);
          if (!room) { send(server, { type: 'error', message: 'room_not_found' }); break; }
          if (room.members.length >= 8) { send(server, { type: 'error', message: 'room_full' }); break; }
          room.members.push(server);
          room.meta.playerCount = room.members.length;
          info.currentRoom = msg.code;
          info.currentRole = 'peer';
          send(server, { type: 'room_joined', code: msg.code });
          broadcast(room.members, { type: 'peer_joined', memberCount: room.members.length }, server);
          this.syncRoomList();
          break;
        }
        case 'offer': {
          const room = this.rooms.get(info.currentRoom);
          if (!room) break;
          broadcast(room.members, { type: 'offer', sdp: msg.sdp, fromRole: info.currentRole }, server);
          break;
        }
        case 'answer': {
          const room = this.rooms.get(info.currentRoom);
          if (!room) break;
          broadcast(room.members, { type: 'answer', sdp: msg.sdp, fromRole: info.currentRole }, server);
          break;
        }
        case 'ice_candidate': {
          const room = this.rooms.get(info.currentRoom);
          if (!room) break;
          broadcast(room.members, { type: 'ice_candidate', candidate: msg.candidate, fromRole: info.currentRole }, server);
          break;
        }
      }
    });

    server.addEventListener('close', () => {
      this.allClients.delete(server);
      if (info.currentRoom && this.rooms.has(info.currentRoom)) {
        const room = this.rooms.get(info.currentRoom);
        room.members = room.members.filter(m => m !== server);
        room.meta.playerCount = room.members.length;
        if (room.members.length === 0) {
          this.rooms.delete(info.currentRoom);
          this.roomMetas.delete(info.currentRoom);
        } else if (room.host === server) {
          broadcast(room.members, { type: 'host_disconnected' });
          this.rooms.delete(info.currentRoom);
          this.roomMetas.delete(info.currentRoom);
        } else {
          broadcast(room.members, { type: 'peer_left', memberCount: room.members.length });
        }
        this.syncRoomList();
      }
    });

    server.addEventListener('error', () => { this.allClients.delete(server); });

    return new Response(null, { status: 101, webSocket: client });
  }
}
