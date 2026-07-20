export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  
  if (url.pathname === '/_test') {
    return new Response('_worker.js OK', { status: 200 });
  }
  
  return context.next();
}
