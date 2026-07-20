// Pages Function - 信令服务器 (WebSocket + Cache API 跨隔离共享)
const ROOM_CODE_LENGTH = 5;
const rooms = new Map();
const roomMetas = new Map();
const allClients = new Set();
const CACHE_NAME = 'monopoly-rooms';
const ROOM_LIST_KEY = 'https://monopoly.internal/room-list';

// 基础定义
function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
function broadcast(room, msg, exclude) { for (const m of room.members) { if (m !== exclude) send(m, msg); } }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (rooms.has(code));
  return code;
}
async function cacheGetList() {
  try { const c = await caches.open(CACHE_NAME); const r = await c.match(ROOM_LIST_KEY); if (r) return await r.json(); } catch (e) {}
  return [];
}
async function cachePutList(list) {
  try { const c = await caches.open(CACHE_NAME); await c.put(ROOM_LIST_KEY, new Response(JSON.stringify(list), { headers: { 'Cache-Control': 'no-store' } })); } catch (e) {}
}
async function syncRoomList() {
  const cached = await cacheGetList();
  const merged = new Map();
  for (const r of cached) merged.set(r.code, r);
  for (const [c, m] of roomMetas) merged.set(c, { code: c, playerCount: m.playerCount });
  const list = Array.from(merged.values());
  await cachePutList(list);
  for (const ws of allClients) { if (ws.readyState === 1) send(ws, { type: 'room_list', rooms: list }); }
}

function handleConnection(ws) {
  let curRoom = null, curRole = null;
  allClients.add(ws);
  cacheGetList().then(list => send(ws, { type: 'room_list', rooms: list }));

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
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
  const url = new URL(request.url);

  // REST API：房间列表（跨隔离用）
  if (url.pathname === '/api/rooms' && request.method === 'GET') {
    const list = await cacheGetList();
    return new Response(JSON.stringify(list), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // WebSocket 信令
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  handleConnection(server);
  return new Response(null, { status: 101, webSocket: client });
}
