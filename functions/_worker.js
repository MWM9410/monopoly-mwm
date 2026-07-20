export async function onRequest(context) {
  return new Response('_worker.js alive! path=' + context.request.url, { status: 200 });
}
