import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, resolve } from 'path';

const PORT = 8080;
const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'application/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  // Serve from public/ or drawable/
  let filePath;
  if (url.startsWith('/drawable/')) {
    filePath = resolve('.' + url);
  } else {
    filePath = resolve('public' + url);
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  const data = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}).listen(PORT, () => {
  console.log(`Dev server: http://localhost:${PORT}`);
  console.log(`Signal server: ws://localhost:3001`);
});
