/**
 * SINVoice — предпросмотр ссылок: заголовок, описание и картинка страницы (Open Graph).
 *
 * Запросы идут только на публичные адреса: каждый IP после DNS проверяется, соединение
 * устанавливается именно с проверенным адресом (защита от DNS rebinding), порты — только 80 и 443,
 * не больше 3 перенаправлений, ответ ограничен по размеру и времени.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { nativeImage } = require('electron');

const TIMEOUT = 6000;
const MAX_HTML = 768 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SINVoice LinkPreview';

/**
 * Частный, служебный или зарезервированный ли адрес.
 * @param {string} ip IPv4 или IPv6
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
  }
  return true;
}

/**
 * DNS-поиск, который пропускает только публичные адреса.
 * @param {string} hostname Имя
 * @param {object} options Параметры
 * @param {Function} callback Ответ
 */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) { callback(err); return; }
    const ok = addresses.find((a) => !isPrivateIp(a.address));
    if (!ok || addresses.some((a) => isPrivateIp(a.address))) {
      callback(new Error('blocked address'));
      return;
    }
    if (options && options.all) callback(null, [ok]);
    else callback(null, ok.address, ok.family);
  });
}

/**
 * Проверяет адрес до запроса.
 * @param {string} raw Ссылка
 * @returns {URL|null}
 */
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIp(host)) return null;
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i.test(host)) return null;
  return u;
}

/**
 * GET-запрос с ограничениями.
 * @param {string} raw Адрес
 * @param {number} limit Наибольший размер тела
 * @param {(type:string) => boolean} acceptType Подходит ли Content-Type
 * @returns {Promise<{body:Buffer, type:string, url:string}>}
 */
function safeGet(raw, limit, acceptType) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const go = (address, hops) => {
      const u = checkUrl(address);
      if (!u) { reject(new Error('bad url')); return; }
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, {
        lookup: safeLookup,
        timeout: TIMEOUT,
        headers: { 'User-Agent': UA, Accept: 'text/html,image/*;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'ru,en;q=0.8' },
      }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (hops >= MAX_REDIRECTS || Date.now() - started > TIMEOUT) { reject(new Error('redirects')); return; }
          go(new URL(res.headers.location, u).href, hops + 1);
          return;
        }
        const type = String(res.headers['content-type'] || '').toLowerCase();
        if (code !== 200 || !acceptType(type)) { res.resume(); reject(new Error(`status ${code}`)); return; }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          req.destroy();
          resolve({ body: Buffer.concat(chunks, size), type, url: u.href });
        };
        stream.on('data', (c) => {
          if (done) return;
          const room = limit - size;
          chunks.push(room < c.length ? c.subarray(0, room) : c);
          size += Math.min(room, c.length);
          if (size >= limit) finish();
        });
        stream.on('end', finish);
        stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    go(raw, 0);
  });
}

/**
 * Раскодирует HTML-сущности в значении атрибута.
 * @param {string} s Строка
 * @returns {string}
 */
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/**
 * Обрезает и чистит текст.
 * @param {string} s Строка
 * @param {number} max Длина
 * @returns {string}
 */
function clean(s, max) {
  const t = decodeEntities(String(s || '')).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Раскодирует HTML с учётом кодировки.
 * @param {Buffer} body Тело
 * @param {string} type Content-Type
 * @returns {string}
 */
function decodeHtml(body, type) {
  let charset = (type.match(/charset=([\w-]+)/) || [])[1];
  if (!charset) {
    const head = body.subarray(0, 4096).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(body);
  } catch (e) {
    return body.toString('utf8');
  }
}

/**
 * Достаёт мета-теги из HTML.
 * @param {string} html Страница
 * @returns {Record<string, string>}
 */
function parseMeta(html) {
  const head = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : html.length);
  const meta = {};
  const tagRe = /<meta\s[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(head))) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (key && content !== undefined) {
      const k = key.toLowerCase();
      if (!(k in meta)) meta[k] = content;
    }
  }
  const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (title) meta['html:title'] = title;
  return meta;
}

/**
 * Загружает картинку и уменьшает её до 400 px по ширине (JPEG).
 * @param {string} src Адрес картинки
 * @returns {Promise<string>} Data URL или пустая строка
 */
async function loadImage(src) {
  try {
    const res = await safeGet(src, MAX_IMAGE, (t) => /^image\/(png|jpe?g|webp|gif)/.test(t));
    if (res.body.length >= MAX_IMAGE) return '';
    const img = nativeImage.createFromBuffer(res.body);
    if (img.isEmpty()) return '';
    const { width, height } = img.getSize();
    if (!width || !height || width > 10000 || height > 10000) return '';
    const small = width > 400 ? img.resize({ width: 400, quality: 'good' }) : img;
    const url = `data:image/jpeg;base64,${small.toJPEG(80).toString('base64')}`;
    return url.length < 150000 ? url : '';
  } catch (e) {
    return '';
  }
}

/**
 * Собирает предпросмотр ссылки.
 * @param {string} raw Ссылка
 * @returns {Promise<{url:string, site:string, title:string, description:string, image:string}|null>}
 */
async function getPreview(raw) {
  if (!checkUrl(raw) || raw.length > 2048) return null;
  try {
    const res = await safeGet(raw, MAX_HTML, (t) => t.includes('text/html') || t.includes('application/xhtml'));
    const meta = parseMeta(decodeHtml(res.body, res.type));
    const title = clean(meta['og:title'] || meta['twitter:title'] || meta['html:title'], 200);
    if (!title) return null;
    const description = clean(meta['og:description'] || meta['twitter:description'] || meta.description, 300);
    const site = clean(meta['og:site_name'], 100) || new URL(res.url).hostname.replace(/^www\./, '');
    let image = '';
    const imgRaw = meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'];
    if (imgRaw) {
      try { image = await loadImage(new URL(decodeEntities(imgRaw), res.url).href); } catch (e) { image = ''; }
    }
    return { url: raw, site, title, description, image };
  } catch (e) {
    return null;
  }
}

module.exports = { getPreview, isPrivateIp, checkUrl };
