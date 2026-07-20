// Pages Function - 信令服务器 (WebSocket)
// 简化版 - 不带 Durable Object
const roomMetas = new Map();
const rooms = new Map();        // 进程内 rooms
const allClients = new Set();

function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
function broadcast(room, msg, exclude) { for (const m of room.members) { if (m !== exclude) send(m, msg); } }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (rooms.has(code));
  return code;
}
function syncRoomList() {
  const list = Array.from(roomMetas.values());
  for (const ws of allClients) { if (ws.readyState === 1) send(ws, { type: 'room_list', rooms: list }); }
}

function handleWs(ws) {
  let curRoom = null, curRole = null;
  allClients.add(ws);
  send(ws, { type: 'room_list', rooms: Array.from(roomMetas.values()) });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    console.log('[signal] msg:', msg.type, msg.code || '');
    switch (msg.type) {
      case 'create_room': {
        if (curRoom) return;
        const code = genCode();
        rooms.set(code, { code, members: [ws], host: ws, meta: { playerCount: 1 } });
        roomMetas.set(code, { code, playerCount: 1 });
        curRoom = code; curRole = 'host';
        send(ws, { type: 'room_created', code });
        syncRoomList();
        break;
      }
      case 'join_room': {
        if (curRoom) return;
        const room = rooms.get(msg.code);
        if (!room) { send(ws, { type: 'error', message: 'room_not_found' }); break; }
        if (room.members.length >= 6) { send(ws, { type: 'error', message: 'room_full' }); break; }
        room.members.push(ws);
        room.meta.playerCount = room.members.length;
        roomMetas.set(msg.code, { code: msg.code, playerCount: room.members.length });
        curRoom = msg.code; curRole = 'peer';
        send(ws, { type: 'room_joined', code: msg.code });
        broadcast(room, { type: 'peer_joined', memberCount: room.members.length }, ws);
        syncRoomList();
        break;
      }
      case 'offer': { const r = rooms.get(curRoom); if (r) broadcast(r, { type: 'offer', sdp: msg.sdp }, ws); break; }
      case 'answer': { const r = rooms.get(curRoom); if (r) broadcast(r, { type: 'answer', sdp: msg.sdp }, ws); break; }
      case 'ice_candidate': { const r = rooms.get(curRoom); if (r) broadcast(r, { type: 'ice_candidate', candidate: msg.candidate }, ws); break; }
    }
  });

  ws.addEventListener('close', () => {
    allClients.delete(ws);
    if (curRoom && rooms.has(curRoom)) {
      const room = rooms.get(curRoom);
      room.members = room.members.filter(m => m !== ws);
      room.meta.playerCount = room.members.length;
      if (room.members.length === 0 || room.host === ws) {
        if (room.host === ws) broadcast(room, { type: 'host_disconnected' });
        rooms.delete(curRoom); roomMetas.delete(curRoom);
      } else { broadcast(room, { type: 'peer_left', memberCount: room.members.length }); }
      syncRoomList();
    }
  });
  ws.addEventListener('error', () => { allClients.delete(ws); });
}

export async function onRequest(context) {
  const { request } = context;
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  handleWs(server);
  return new Response(null, { status: 101, webSocket: client });
}
