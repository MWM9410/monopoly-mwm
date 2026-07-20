// Pages Function - 信令服务器 (WebSocket → Durable Object)
// 部署在 Cloudflare Pages 同域名下：wss://xxx.pages.dev/signal

export async function onRequest(context) {
  const { request, env } = context;

  // 获取 Durable Object stub（全局唯一实例）
  const id = env.SIGNAL_ROOM.idFromName("global");
  const stub = env.SIGNAL_ROOM.get(id);

  // 将请求转发给 Durable Object 处理
  return stub.fetch(request);
}
