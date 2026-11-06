'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validRendererOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) return '';
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? url.origin : '';
  } catch (_) { return ''; }
}

function loadRendererOrigin(userDataPath, persist = true) {
  const configFile = path.join(userDataPath, 'renderer-origin.json');
  let origin = '';
  try { origin = validRendererOrigin(JSON.parse(fs.readFileSync(configFile, 'utf8')).origin); } catch (_) {}
  if (origin) return origin;
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(userDataPath, 'startup-state.json'), 'utf8'));
    origin = validRendererOrigin(previous.targetUrl)
      || validRendererOrigin(`http://127.0.0.1:${Number(previous.port)}`);
  } catch (_) {}
  origin ||= 'http://127.0.0.1:3000';
  if (persist) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const temporary = `${configFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, origin }), 'utf8');
    fs.renameSync(temporary, configFile);
  }
  return origin;
}

function createLocalProtocolHandler({ origin, backendOrigin, tokenHeaders, remoteFetch, localFetch = fetch }) {
  return async function handleLocalAppRequest(request) {
    const url = new URL(request.url);
    if (url.origin !== origin) return remoteFetch(request);
    const headers = new Headers(request.headers);
    const claimedOrigin = headers.get('origin');
    const referrer = headers.get('referer') || request.referrer || '';
    let sameReferrer = false;
    try { sameReferrer = new URL(referrer).origin === origin; } catch (_) {}
    const site = headers.get('sec-fetch-site');
    const trusted = (!claimedOrigin || claimedOrigin === origin)
      && (!site || site === 'same-origin' || site === 'none')
      && (claimedOrigin === origin || sameReferrer || site === 'same-origin');
    if (url.pathname.startsWith('/api/') && !trusted) {
      return new Response('Forbidden', { status: 403 });
    }
    const targetOrigin = backendOrigin();
    if (!targetOrigin) return new Response('Service unavailable', { status: 503 });
    for (const name of ['host', 'cookie', 'connection', 'content-length', 'x-mineradio-token']) headers.delete(name);
    if (claimedOrigin || trusted) headers.set('origin', targetOrigin);
    if (sameReferrer) headers.set('referer', `${targetOrigin}/`);
    if (trusted) {
      for (const [name, value] of Object.entries(tokenHeaders())) headers.set(name, value);
    }
    try {
      const response = await localFetch(`${targetOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        duplex: 'half',
        redirect: 'manual',
        signal: request.signal,
      });
      const responseHeaders = new Headers(response.headers);
      // Node's fetch decodes compression, while retaining upstream length/encoding.
      if (responseHeaders.has('content-encoding')) {
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
      }
      responseHeaders.delete('set-cookie');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch (error) {
      if (request.signal && request.signal.aborted) throw error;
      return new Response('Local service unavailable', { status: 502 });
    }
  };
}

module.exports = { loadRendererOrigin, createLocalProtocolHandler };
