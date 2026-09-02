import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, normalize, resolve, sep } from 'node:path';

const root = resolve('packages/renderer/dist-web');
const host = process.env.PREVIEW_HOST ?? '::';
const port = Number(process.env.PREVIEW_PORT ?? 5180);

if (!existsSync(root)) {
  throw new Error('Web preview is missing. Run the renderer build before serving it.');
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry && !entry.internal)
  .map((entry) => entry.address);
const lanAddress = addresses.find((address) => address.startsWith('192.168.'));
const tailscaleAddress = addresses.find((address) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address));

function isAllowedClient(address) {
  const value = address.replace(/^::ffff:/, '').toLowerCase();
  if (value === '::1' || value.startsWith('127.')) return true;
  if (value.startsWith('192.168.') || value.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return true;
  return value.startsWith('fd7a:115c:a1e0:');
}

const server = createServer((request, response) => {
  if (!isAllowedClient(request.socket.remoteAddress ?? '')) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Private network preview only.');
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Method not allowed.');
    return;
  }

  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const relativePath = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '');
  const filePath = resolve(root, relativePath);

  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Invalid path.');
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found.');
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    createReadStream(filePath).pipe(response);
  }
});

server.listen({ host, port }, () => {
  if (lanAddress) console.log(`Web preview: http://${lanAddress}:${port}/?preview=work-queue`);
  if (tailscaleAddress) console.log(`Tailscale:   http://${tailscaleAddress}:${port}/?preview=work-queue`);
  console.log('Access is restricted to loopback, private LAN, and Tailscale clients.');
});
