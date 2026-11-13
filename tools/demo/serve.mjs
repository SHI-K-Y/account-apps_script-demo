#!/usr/bin/env node
// 本機預覽建置好的 Demo 網站（純靜態檔案伺服器）。
//
//   node tools/demo/serve.mjs                    → http://localhost:8090 （預設提供 docs/）
//   node tools/demo/serve.mjs --dir 目錄 --port 9000
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.indexOf(name) > -1 ? argv[argv.indexOf(name) + 1] : fallback);
const dir = path.resolve(arg('--dir', path.join(ROOT, 'docs')));
const port = Number(arg('--port', 8090));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error('找不到 ' + path.join(dir, 'index.html') + '，請先建置 Demo 網站。');
  process.exit(1);
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(dir, pathname.endsWith('/') ? pathname + 'index.html' : pathname);
  // 不允許讀取提供目錄以外的檔案。
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log('Demo 網站預覽：http://localhost:' + port + '（提供 ' + path.relative(process.cwd(), dir) + '/）');
});
