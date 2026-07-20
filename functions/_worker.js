export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === '/test-worker') {
    return new Response(JSON.stringify({ ok: true, envKeys: Object.keys(env).join(',') }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return env.ASSETS.fetch(request);
}
