import fs from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fault, hash } from '../store.mjs';
import { LIFE_OCR_LIMIT } from '../life-ocr.mjs';

const codeLifetime = 5 * 60_000;
const sessionLifetime = 8 * 3600_000;
const allowedFiles = new Map([
  ['/', ['dinner-mobile.html', 'text/html; charset=utf-8']],
  ['/dinner-mobile.js', ['dinner-mobile.js', 'text/javascript; charset=utf-8']],
  ['/dinner-ui.js', ['dinner-ui.js', 'text/javascript; charset=utf-8']],
  ['/life-ui.js', ['life-ui.js', 'text/javascript; charset=utf-8']],
  ['/dinner.css', ['dinner.css', 'text/css; charset=utf-8']],
  ['/app-icon.png', ['app-icon.png', 'image/png']],
]);

function privateIpv4(address) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
}

function sameSecret(a, b) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function body(req, limit = 20_000) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw fault('请从小鲸鱼手机页面提交。', 415);
  }
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw fault('提交内容过大。', 413);
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw fault('提交内容无效。'); }
}

export class DinnerGateway {
  constructor(service, assets, { now = Date.now, interfaces = networkInterfaces, loopback = false } = {}) {
    this.service = service;
    this.assets = assets;
    this.now = now;
    this.interfaces = interfaces;
    this.loopback = loopback;
  }

  addresses() {
    const available = new Map();
    for (const [name, entries] of Object.entries(this.interfaces())) {
      for (const entry of entries) {
        if (entry.family !== 'IPv4') continue;
        if ((!entry.internal && privateIpv4(entry.address)) || (this.loopback && entry.address === '127.0.0.1')) {
          available.set(entry.address, { name, address: entry.address });
        }
      }
    }
    return [...available.values()];
  }

  status() {
    const active = this.session && this.session.expiresAt > this.now();
    const unexpiredCode = this.code && this.code.expiresAt > this.now() && this.code.attempts < 8;
    return {
      url: this.url ?? '', addresses: this.addresses(), connected: Boolean(active),
      code: unexpiredCode ? this.code.value.match(/.{4}/g).join('-').toUpperCase() : '',
      expiresAt: unexpiredCode ? this.code.expiresAt : null,
    };
  }

  async start(address) {
    if (!this.addresses().some(row => row.address === address)) throw fault('请选择正在连接的局域网 IPv4 地址。');
    if (this.server) throw fault('手机入口已开启，可刷新配对码或先关闭。', 409);
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    server.maxConnections = 12;
    server.headersTimeout = 10_000;
    server.requestTimeout = 25_000;
    server.keepAliveTimeout = 3_000;
    try {
      await new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(0, address, () => { server.removeListener('error', onError); resolve(); });
      });
      if (this.server !== server || !server.address()) throw Error('server closed');
      server.on('error', () => { if (this.server === server) this.close(); });
      this.url = `http://${address}:${server.address().port}`;
      return this.renew();
    } catch {
      if (this.server === server) this.close();
      throw fault('手机入口无法在该地址启动，请换一个已连接的网卡。', 503);
    }
  }

  renew() {
    if (!this.url) throw fault('请先开启手机入口。', 409);
    this.session?.controller.abort();
    this.session = null;
    this.code = { value: randomBytes(6).toString('hex'), expiresAt: this.now() + codeLifetime, attempts: 0 };
    return this.status();
  }

  pair(input) {
    if (!this.code || this.code.expiresAt <= this.now() || this.code.attempts >= 8) throw fault('配对码已失效，请在桌面刷新。', 429);
    this.code.attempts++;
    const candidate = typeof input === 'string' && input.length <= 30 ? input.replace(/[\s-]/g, '').toLowerCase() : '';
    if (!/^[a-f0-9]{12}$/.test(candidate) || !sameSecret(candidate, this.code.value)) throw fault('配对码不正确。', 403);
    this.code = null;
    const token = randomBytes(32).toString('hex');
    this.session?.controller.abort();
    this.session = { hash: hash(token), expiresAt: this.now() + sessionLifetime, controller: new AbortController() };
    return { token, expiresAt: this.session.expiresAt };
  }

  async handle(req, res) {
    const reply = (status, data, type = 'application/json; charset=utf-8') => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const origin = this.url;
      if (!origin || req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== origin)) throw fault('请通过配对页面访问。', 403);
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw fault('请通过配对页面访问。', 403);
      const asset = req.method === 'GET' && allowedFiles.get(url.pathname);
      if (asset) return reply(200, fs.readFileSync(path.join(this.assets, asset[0])), asset[1]);
      if (req.method === 'POST' && req.headers.origin !== origin) throw fault('请通过配对页面提交操作。', 403);
      if (req.method === 'POST' && url.pathname === '/api/dinner/pair') {
        const input = await body(req);
        if (this.url !== origin) throw fault('手机入口已关闭。', 409);
        return reply(200, this.pair(input?.code));
      }
      const unpair = url.pathname === '/api/dinner/unpair' && req.method === 'POST';
      const ocr = url.pathname === '/api/dinner/ocr' && req.method === 'POST';
      if (!unpair && !ocr && (url.pathname !== '/api/dinner' || !['GET', 'POST'].includes(req.method))) throw fault('页面不存在。', 404);
      const auth = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
      const session = this.session;
      if (!auth || !session || session.expiresAt <= this.now() || !sameSecret(hash(auth[1]), session.hash)) {
        throw fault('手机配对已失效，请在桌面获取新配对码。', 401);
      }
      if (req.method === 'GET') {
        if (url.searchParams.get('view') === 'life') return reply(200, this.service.life.view(url.searchParams.get('id')));
        const { platformWindow, ...view } = this.service.view(url.searchParams.get('id'));
        return reply(200, view);
      }
      const input = await body(req, ocr ? LIFE_OCR_LIMIT : 20_000);
      if (this.session !== session || session.expiresAt <= this.now()) throw fault('手机配对已失效。', 401);
      if (unpair) {
        session.controller.abort();
        this.session = null;
        return reply(200, { ok: true });
      }
      const result = ocr ? await this.service.life.ocr(input, session.controller.signal) :
        await this.service.dispatch(input, { signal: session.controller.signal });
      if (this.session !== session || session.expiresAt <= this.now()) throw fault('手机配对已失效。', 401);
      return reply(200, result);
    } catch (error) {
      reply(error.status ?? 500, { error: error.status ? error.message : '晚饭任务暂时无法读取，请在桌面重试。' });
    }
  }

  close() {
    const server = this.server;
    this.url = '';
    this.server = null;
    this.code = null;
    this.session?.controller.abort();
    this.session = null;
    if (server) {
      server.close();
      server.closeAllConnections();
    }
    return this.status();
  }
}
