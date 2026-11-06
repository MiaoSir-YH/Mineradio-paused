'use strict';

const crypto = require('node:crypto');

function createLocalRequestSecurity({ standalone = false, host = '127.0.0.1' } = {}) {
  const secret = crypto.randomBytes(32).toString('hex');
  let bootstrap = standalone ? crypto.randomBytes(32).toString('hex') : '';
  const matches = (value, expected) => typeof value === 'string' && !!expected &&
    Buffer.byteLength(value) === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));

  function inspect(req, port) {
    const raw = String(req.url || '');
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) {
      return { status: 400, error: 'INVALID_REQUEST_URL' };
    }
    let origin;
    let url;
    try {
      const authority = String(req.headers.host || '');
      origin = new URL('http://' + authority);
      const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
      if (!['0.0.0.0', '::'].includes(host)) allowedHosts.add(host);
      if (origin.host !== authority.toLowerCase() || !allowedHosts.has(origin.hostname) ||
          Number(origin.port || 80) !== Number(port) || origin.username || origin.password) {
        return { status: 403, error: 'HOST_NOT_ALLOWED' };
      }
      url = new URL(raw, origin.origin);
    } catch (_) { return { status: 400, error: 'INVALID_REQUEST_URL' }; }
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== origin.origin) return { status: 403, error: 'ORIGIN_NOT_ALLOWED' };
    const site = req.headers['sec-fetch-site'];
    if (site && !['same-origin', 'none'].includes(site)) return { status: 403, error: 'ORIGIN_NOT_ALLOWED' };
    if (req.headers.referer) {
      try {
        if (new URL(req.headers.referer).origin !== origin.origin) return { status: 403, error: 'ORIGIN_NOT_ALLOWED' };
      } catch (_) { return { status: 403, error: 'ORIGIN_NOT_ALLOWED' }; }
    }
    const cookieName = 'mineradio_session_' + port;
    if (standalone && req.method === 'GET' && url.pathname === '/' && matches(url.searchParams.get('mineradio_session'), bootstrap)) {
      bootstrap = '';
      return { status: 303, cookie: cookieName + '=' + secret + '; HttpOnly; SameSite=Strict; Path=/', location: '/' };
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const cookie = standalone && String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='));
      if (!matches(req.headers['x-mineradio-token'], secret) && !matches(cookie && cookie.slice(cookieName.length + 1), secret)) {
        return { status: 401, error: 'LOCAL_SESSION_REQUIRED' };
      }
    }
    return { url };
  }
  return {
    inspect,
    getHeaders: () => ({ 'x-mineradio-token': secret }),
    bootstrapUrl: port => bootstrap ? 'http://127.0.0.1:' + port + '/?mineradio_session=' + bootstrap : '',
  };
}

module.exports = { createLocalRequestSecurity };
